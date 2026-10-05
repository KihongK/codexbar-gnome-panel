// Presentation only. The codexbar-linux desktop app owns provider selection, polling and
// notifications; this extension reads its snapshot over the local IPC used by other adapters.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const POLL_SECONDS = 15;
const BUSY_POLL_MS = 1500;
const CARD_WIDTH = 300;
const OVERVIEW = 'overview';
// Brand colors match the Mac provider descriptors.
const PROVIDERS = {
    codex: {name: 'Codex', color: '#49a3b0'},
    claude: {name: 'Claude', color: '#cc7c5e'},
    grok: {name: 'Grok', color: '#10a37f'},
    copilot: {name: 'GitHub Copilot'}, gemini: {name: 'Gemini'}, cursor: {name: 'Cursor'},
    antigravity: {name: 'Antigravity'}, openrouter: {name: 'OpenRouter'}, kiro: {name: 'Kiro'},
};
const LOGOS = new Set(['codex', 'claude', 'grok']);
const WARNING = '#f5a623';

function providerName(id) {
    return PROVIDERS[id]?.name || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Unknown provider');
}

// The backend labels windows by cadence ("5 hour", "7 day"); match the Mac wording.
function windowLabel(label) {
    if (/^\d+(\.\d+)? hour$/.test(label)) return 'Session';
    if (label === '7 day') return 'Weekly';
    if (label === '1 day') return 'Daily';
    return label || 'Quota';
}

function ago(timestamp) {
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) return '';
    const minutes = Math.floor((Date.now() - time) / 60000);
    if (minutes < 1) return 'Updated just now';
    if (minutes < 60) return `Updated ${minutes}m ago`;
    return `Updated ${Math.floor(minutes / 60)}h ago`;
}

function amount(value, currency) {
    if (typeof value !== 'number') return '';
    if (!currency || currency === 'USD') return `$${value.toFixed(2)}`;
    return `${Math.round(value).toLocaleString('en-US')} ${currency.toLowerCase()}`;
}

function findExecutable() {
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'codexbar-linux']);
    if (GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE)) return local;
    return GLib.find_program_in_path('codexbar-linux');
}

function label(text, style, props = {}) {
    const widget = new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER, ...props});
    widget.clutter_text.line_wrap = true;
    return widget;
}

// A row with text pinned left and right, as in the Mac menu card.
function split(left, right, style = 'codexbar-meta') {
    const row = new St.BoxLayout({style_class: 'codexbar-split'});
    row.add_child(label(left, style, {x_expand: true}));
    if (right) row.add_child(label(right, style, {x_align: Clutter.ActorAlign.END}));
    return row;
}

function bar(window, color, width = CARD_WIDTH) {
    const value = Math.max(0, Math.min(100, Number(window.displayValue) || 0));
    const fillColor = window.warning ? WARNING : color;
    const track = new St.Widget({style_class: 'codexbar-track', width, layout_manager: new Clutter.FixedLayout()});
    track.add_child(new St.Widget({
        style_class: 'codexbar-fill',
        style: fillColor ? `background-color: ${fillColor};` : '',
        width: Math.round(width * value / 100),
    }));
    // The pace marker shows where usage would be if spent evenly across the window.
    if (typeof window.paceExpected === 'number') {
        const expected = window.displaySuffix === 'used' ? window.paceExpected : 100 - window.paceExpected;
        const x = Math.round(width * Math.max(0, Math.min(100, expected)) / 100);
        track.add_child(new St.Widget({style_class: 'codexbar-pace', x: Math.max(0, Math.min(width - 3, x - 1))}));
    }
    return track;
}

function percent(window) {
    return `${Math.round(window.displayValue)}% ${window.displaySuffix || 'left'}`;
}

// Polls the desktop backend once for every indicator and notifies them on change.
class SnapshotSource {
    constructor() {
        this.executable = findExecutable();
        this.snapshot = null;
        this._raw = null;
        this._listeners = new Set();
        this._cancellable = new Gio.Cancellable();
        this._busyId = 0;
        this._timers = new Set();
        this.wantsSpending = () => false;
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this.poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    connect(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    run(args, stderr = false) {
        if (!this.executable) return null;
        try {
            return Gio.Subprocess.new([this.executable, ...args], Gio.SubprocessFlags.STDOUT_PIPE |
                (stderr ? Gio.SubprocessFlags.STDERR_PIPE : Gio.SubprocessFlags.STDERR_SILENCE));
        } catch (error) {
            logError(error, 'CodexBar');
            return null;
        }
    }

    pollSoon(delay = 400) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timers.delete(id);
            this.poll();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    // Spending is a local history scan, so it is only requested while a menu is visible.
    // Released backends without --with-spending reject the option; fall back to a plain snapshot.
    async poll() {
        const spending = this.wantsSpending() && !this._noSpendingOption;
        const process = this.run(spending ? ['--snapshot', '--with-spending'] : ['--snapshot'], true);
        if (!process) return this._update(null, '');
        try {
            const [stdout, stderr] = await process.communicate_utf8_async(null, this._cancellable);
            if (this._cancellable.is_cancelled()) return;
            if (spending && !process.get_successful() && /with-spending/.test(stderr ?? '')) {
                this._noSpendingOption = true;
                return this.poll();
            }
            const data = process.get_successful() ? JSON.parse(stdout) : null;
            const valid = data && data.schemaVersion === 1 && Array.isArray(data.entries);
            this._update(valid ? data : null, valid ? stdout : '');
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) this._update(null, '');
        }
    }

    _update(snapshot, raw) {
        // While the backend is fetching, poll quickly so results appear without waiting a full cycle.
        if ((snapshot?.busy || snapshot?.costBusy) && !this._busyId) {
            this._busyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BUSY_POLL_MS, () => {
                this._busyId = 0;
                this.poll();
                return GLib.SOURCE_REMOVE;
            });
        }
        if (raw === this._raw) return;
        this._raw = raw;
        this.snapshot = snapshot;
        // A listener may replace indicators, so skip any it removed during this pass.
        for (const listener of [...this._listeners]) if (this._listeners.has(listener)) listener(snapshot);
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of [this._pollId, this._busyId, ...this._timers]) if (id) GLib.source_remove(id);
        this._timers.clear();
        this._listeners.clear();
    }
}

const BaseIndicator = GObject.registerClass(
class BaseIndicator extends PanelMenu.Button {
    _init(extension, source, name) {
        super._init(0.5, name);
        this._extension = extension;
        this._source = source;

        this._box = new St.BoxLayout({style_class: 'codexbar-panel'});
        this.add_child(this._box);
        this._content = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._content);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._footer = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._footer);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) source.poll();
        });
        this._disconnect = source.connect(() => this.render());
    }

    render() {
        this._box.destroy_all_children();
        this._content.removeAll();
        this._footer.removeAll();
        this.renderPanel(this._source.snapshot);
        this.renderMenu(this._source.snapshot);
        this._renderFooter(this._source.snapshot);
    }

    icon(provider, size) {
        const name = LOGOS.has(provider) ? `codexbar-${provider}-symbolic.svg` : 'codexbar-symbolic.svg';
        const file = this._extension.dir.get_child('icons').get_child(name);
        return new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: size, style_class: 'codexbar-icon'});
    }

    segment(entry, gap) {
        const first = entry.windows?.[0];
        const segment = new St.BoxLayout({style_class: gap ? 'codexbar-segment codexbar-segment-gap' : 'codexbar-segment'});
        segment.add_child(this.icon(entry.provider, 15));
        segment.add_child(label(first ? `${Math.round(first.displayValue)}%` : '—',
            first?.warning ? 'codexbar-value codexbar-warning' : 'codexbar-value'));
        return segment;
    }

    notice(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.label.add_style_class_name('codexbar-dim');
        return item;
    }

    // Returns a reason when no provider can be shown, so every indicator explains it the same way.
    unavailable(snapshot) {
        if (!this._source.executable) return 'codexbar-linux was not found in ~/.local/bin or PATH.';
        if (!snapshot) return 'CodexBar is not running.';
        if (!snapshot.entries.length) return snapshot.busy ? 'Loading usage…' : snapshot.error || 'No providers selected.';
        return '';
    }

    _renderFooter(snapshot) {
        const source = this._source;
        if (!source.executable) return;
        if (!snapshot) {
            this._footer.addAction('Start CodexBar', () => source.run(['--background']) && source.pollSoon());
        } else {
            this._footer.addAction(snapshot.busy ? 'Refreshing…' : 'Refresh', () => {
                source.run(['--refresh']);
                source.pollSoon();
            });
        }
        this._footer.addAction('Usage & Spend…', () => source.run(['--usage']));
        this._footer.addAction('Settings…', () => source.run(['--settings']));
    }

    card(entry, snapshot) {
        const spending = (snapshot.spending ?? []).find(row => row.provider === entry.provider);
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'codexbar-card'});
        const column = new St.BoxLayout({vertical: true, x_expand: true, width: CARD_WIDTH});
        item.add_child(column);
        const color = PROVIDERS[entry.provider]?.color;

        const header = new St.BoxLayout({style_class: 'codexbar-card-header'});
        header.add_child(this.icon(entry.provider, 18));
        header.add_child(label(providerName(entry.provider), 'codexbar-title', {x_expand: true}));
        if (entry.plan) header.add_child(label(entry.plan, 'codexbar-plan'));
        column.add_child(header);

        const updated = snapshot.stale ? 'Out of date' : ago(entry.updatedAt);
        const statusStyle = ['major', 'critical'].includes(entry.statusLevel) ? 'codexbar-meta codexbar-error'
            : entry.statusLevel === 'minor' ? 'codexbar-meta codexbar-warning' : 'codexbar-meta';
        if (updated || entry.status) {
            const row = split(updated, '');
            if (entry.status) row.add_child(label(entry.status, statusStyle));
            column.add_child(row);
        }

        if (entry.error) column.add_child(label(entry.error, 'codexbar-error'));
        for (const window of entry.windows ?? []) {
            const box = new St.BoxLayout({vertical: true, style_class: 'codexbar-window'});
            box.add_child(label(windowLabel(window.label), 'codexbar-window-label'));
            box.add_child(bar(window, color));
            box.add_child(split(percent(window), window.resetText || ''));
            if (window.pace) {
                const parts = window.pace.split('|').map(part => part.trim()).filter(Boolean);
                const lasts = parts.find(part => /^(Lasts until reset|Runs out)/.test(part)) || '';
                box.add_child(split(parts[0] || '', lasts));
            }
            column.add_child(box);
        }

        const extras = [];
        if (typeof entry.credits === 'number') extras.push(['Credits', `${Math.round(entry.credits).toLocaleString('en-US')} left`]);
        const extra = entry.extraUsage;
        if (extra) {
            const name = extra.period || 'Extra usage';
            if (typeof extra.limit === 'number' && extra.limit > 0)
                extras.push([name, `${amount(extra.used ?? 0, extra.currency)} / ${amount(extra.limit, extra.currency)}`]);
            else if (typeof extra.balance === 'number' && extra.currency !== 'Credits')
                extras.push([name, `${amount(extra.balance, extra.currency)} left`]);
        }
        const resets = entry.resetCredits;
        if (resets && resets.available > 0) {
            const days = Math.ceil((Date.parse(resets.nextExpiresAt) - Date.now()) / 86400000);
            const expiry = Number.isFinite(days) ? ` · next expires in ${Math.max(0, days)}d` : '';
            extras.push(['Reset credits', `${resets.available} available${expiry}`]);
        }
        if (spending && !spending.error) {
            if (typeof spending.today === 'number') extras.push(['Cost today', amount(spending.today)]);
            if (typeof spending.month === 'number') extras.push(['Last 30 days', amount(spending.month)]);
        }
        if (extras.length) {
            const box = new St.BoxLayout({vertical: true, style_class: 'codexbar-extras'});
            for (const [left, right] of extras) box.add_child(split(left, right, 'codexbar-extra'));
            column.add_child(box);
        }
        return item;
    }

    destroy() {
        this._disconnect?.();
        this._disconnect = null;
        super.destroy();
    }
});

// One top bar button for every provider, with a Mac-style switcher between Overview and each provider.
const MergedIndicator = GObject.registerClass(
class MergedIndicator extends BaseIndicator {
    _init(extension, source) {
        super._init(extension, source, 'CodexBar');
        this._tab = OVERVIEW;
        this.render();
    }

    renderPanel(snapshot) {
        const entries = snapshot?.entries ?? [];
        if (!entries.length) {
            this._box.add_child(this.icon('', 16));
            this._box.add_child(label('—', 'codexbar-value'));
            return;
        }
        this._box.opacity = snapshot.stale ? 150 : 255;
        entries.slice(0, 4).forEach((entry, index) => this._box.add_child(this.segment(entry, index > 0)));
        if (entries.length > 4) this._box.add_child(label(`+${entries.length - 4}`, 'codexbar-value codexbar-dim'));
    }

    renderMenu(snapshot) {
        const reason = this.unavailable(snapshot);
        if (reason) return this._content.addMenuItem(this.notice(reason));
        const entries = snapshot.entries;
        if (this._tab !== OVERVIEW && !entries.some(entry => entry.provider === this._tab)) this._tab = OVERVIEW;
        if (entries.length > 1) {
            this._content.addMenuItem(this._switcher(entries));
            this._content.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        const selected = entries.length === 1 ? entries[0] : entries.find(entry => entry.provider === this._tab);
        if (selected) this._content.addMenuItem(this.card(selected, snapshot));
        else entries.forEach(entry => this._content.addMenuItem(this._overviewRow(entry)));
    }

    // Rebuild after the click finishes, since the clicked item is replaced.
    _select(tab) {
        this._tab = tab;
        if (this._selectId) return;
        this._selectId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._selectId = 0;
            this.render();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._selectId) GLib.source_remove(this._selectId);
        this._selectId = 0;
        super.destroy();
    }

    _switcher(entries) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'codexbar-switcher-item'});
        const row = new St.BoxLayout({style_class: 'codexbar-switcher', x_expand: true});
        const tab = (id, child, text) => {
            const content = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER});
            child.x_align = Clutter.ActorAlign.CENTER;
            content.add_child(child);
            content.add_child(label(text, 'codexbar-tab-label', {x_align: Clutter.ActorAlign.CENTER}));
            const button = new St.Button({
                child: content, x_expand: true, can_focus: true,
                style_class: id === this._tab ? 'codexbar-tab codexbar-tab-active' : 'codexbar-tab',
            });
            button.connect('clicked', () => this._select(id));
            row.add_child(button);
        };
        tab(OVERVIEW, new St.Icon({icon_name: 'view-grid-symbolic', icon_size: 16}), 'Overview');
        for (const entry of entries) tab(entry.provider, this.icon(entry.provider, 16), providerName(entry.provider));
        item.add_child(row);
        return item;
    }

    // Compact Overview row: the provider's leading window, clickable to open its full card.
    _overviewRow(entry) {
        const item = new PopupMenu.PopupBaseMenuItem({style_class: 'codexbar-overview-row'});
        const column = new St.BoxLayout({vertical: true, x_expand: true, width: CARD_WIDTH});
        const header = new St.BoxLayout({style_class: 'codexbar-card-header'});
        header.add_child(this.icon(entry.provider, 16));
        header.add_child(label(providerName(entry.provider), 'codexbar-window-label', {x_expand: true}));
        const first = entry.windows?.[0];
        header.add_child(label(first ? percent(first) : entry.error ? 'Unavailable' : '—',
            first?.warning ? 'codexbar-meta codexbar-warning' : 'codexbar-meta'));
        column.add_child(header);
        if (first) {
            column.add_child(bar(first, PROVIDERS[entry.provider]?.color));
            const rest = entry.windows.slice(1, 3).map(window => `${windowLabel(window.label)} ${Math.round(window.displayValue)}%`);
            column.add_child(split(`${windowLabel(first.label)} · ${first.resetText || ''}`, rest.join(' · ')));
        }
        item.add_child(column);
        // Switching tabs keeps the menu open, like the Mac provider switcher.
        item.activate = () => this._select(entry.provider);
        return item;
    }
});

// One top bar button per provider, each with its own menu, as with Merge icons turned off on the Mac.
const ProviderIndicator = GObject.registerClass(
class ProviderIndicator extends BaseIndicator {
    _init(extension, source, provider) {
        super._init(extension, source, `CodexBar ${providerName(provider)}`);
        this.provider = provider;
        this.render();
    }

    _entry(snapshot) {
        return snapshot?.entries.find(entry => entry.provider === this.provider);
    }

    renderPanel(snapshot) {
        const entry = this._entry(snapshot);
        this._box.opacity = snapshot?.stale ? 150 : 255;
        this._box.add_child(this.segment(entry ?? {provider: this.provider, windows: []}, false));
    }

    renderMenu(snapshot) {
        const entry = this._entry(snapshot);
        const reason = this.unavailable(snapshot);
        if (reason || !entry) return this._content.addMenuItem(this.notice(reason || 'This provider is no longer selected.'));
        this._content.addMenuItem(this.card(entry, snapshot));
    }
});

export default class CodexBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._source = new SnapshotSource();
        this._source.wantsSpending = () => this._indicators().some(indicator => indicator.menu.isOpen);
        this._merged = null;
        this._separate = new Map();
        this._disconnect = this._source.connect(() => this._sync());
        this._settingsId = this._settings.connect('changed::merge-icons', () => this._sync(true));
        this._sync();
        this._source.poll();
    }

    _indicators() {
        return [this._merged, ...this._separate.values()].filter(Boolean);
    }

    // Separate buttons follow the backend's provider order; a missing backend keeps one placeholder button.
    _sync(rebuild = false) {
        if (rebuild) this._clear();
        const merge = this._settings.get_boolean('merge-icons');
        const providers = (this._source.snapshot?.entries ?? []).map(entry => entry.provider);
        if (merge || !providers.length) {
            for (const indicator of this._separate.values()) indicator.destroy();
            this._separate.clear();
            if (!this._merged) {
                this._merged = new MergedIndicator(this, this._source);
                Main.panel.addToStatusArea(this.uuid, this._merged);
            }
            return;
        }
        this._merged?.destroy();
        this._merged = null;
        const current = [...this._separate.keys()];
        if (current.join() === providers.join()) return;
        for (const indicator of this._separate.values()) indicator.destroy();
        this._separate.clear();
        providers.forEach((provider, index) => {
            const indicator = new ProviderIndicator(this, this._source, provider);
            Main.panel.addToStatusArea(`${this.uuid}:${provider}`, indicator, index, 'right');
            this._separate.set(provider, indicator);
        });
    }

    _clear() {
        this._merged?.destroy();
        this._merged = null;
        for (const indicator of this._separate.values()) indicator.destroy();
        this._separate.clear();
    }

    disable() {
        this._disconnect?.();
        if (this._settingsId) this._settings.disconnect(this._settingsId);
        this._clear();
        this._source?.destroy();
        this._source = this._settings = this._disconnect = null;
        this._settingsId = 0;
    }
}
