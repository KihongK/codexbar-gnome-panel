UUID := codexbar-panel@kihongk.github.io

.PHONY: pack install link check

pack:
	gnome-extensions pack --force --extra-source=icons $(UUID)

install: pack
	gnome-extensions install --force $(UUID).shell-extension.zip
	@echo "Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

# Development install: edits apply after the next login.
link:
	glib-compile-schemas $(UUID)/schemas
	ln -sfn "$(CURDIR)/$(UUID)" "$(HOME)/.local/share/gnome-shell/extensions/$(UUID)"

check:
	for file in extension prefs; do cp $(UUID)/$$file.js /tmp/codexbar-panel-$$file.mjs && node --check /tmp/codexbar-panel-$$file.mjs || exit 1; done
	glib-compile-schemas --strict --dry-run $(UUID)/schemas
