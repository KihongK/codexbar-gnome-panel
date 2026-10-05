import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CodexBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const bar = new Adw.PreferencesGroup({title: 'Top bar'});
        const merge = new Adw.SwitchRow({
            title: 'Merge icons',
            subtitle: 'Use a single top bar button with a provider switcher. Turn off for one button per provider.',
        });
        settings.bind('merge-icons', merge, 'active', Gio.SettingsBindFlags.DEFAULT);
        bar.add(merge);
        page.add(bar);

        // Provider selection, order and refresh live in the desktop app so every adapter agrees.
        const providers = new Adw.PreferencesGroup({
            title: 'Providers',
            description: 'Choose providers, their order and the refresh interval in CodexBar Settings → Providers.',
        });
        const open = new Adw.ActionRow({title: 'Open CodexBar Settings', activatable: true});
        open.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        open.connect('activated', () => {
            const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'codexbar-linux']);
            const executable = GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : 'codexbar-linux';
            try {
                Gio.Subprocess.new([executable, '--settings'], Gio.SubprocessFlags.NONE);
            } catch (error) {
                logError(error, 'CodexBar');
            }
        });
        providers.add(open);
        page.add(providers);

        window.add(page);
    }
}
