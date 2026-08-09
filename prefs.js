import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';

import {
    ExtensionPreferences, gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Row that captures a single accelerator and writes it back as a strv.
const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init(settings, key, title, subtitle) {
        super._init({ title, subtitle });
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv(key)[0] ?? '',
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);

        const setBtn = new Gtk.Button({
            label: _('Set'), valign: Gtk.Align.CENTER,
        });
        setBtn.connect('clicked', () => this._capture());
        this.add_suffix(setBtn);

        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        clearBtn.connect('clicked', () => {
            settings.set_strv(key, []);
            this._label.set_accelerator('');
        });
        this.add_suffix(clearBtn);

        this.activatable_widget = setBtn;
    }

    _capture() {
        const dialog = new Adw.MessageDialog({
            transient_for: this.get_root(),
            heading: _('Press a shortcut'),
            body: _('Press Esc to cancel.'),
        });
        dialog.add_response('cancel', _('Cancel'));

        const controller = new Gtk.EventControllerKey();
        dialog.add_controller(controller);
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape) { dialog.close(); return Gdk.EVENT_STOP; }
            // Ignore bare modifier presses while the user is still reaching.
            if (!mask && (keyval === Gdk.KEY_Super_L || keyval === Gdk.KEY_Super_R ||
                keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Alt_L ||
                keyval === Gdk.KEY_Shift_L))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
            this._settings.set_strv(this._key, [accel]);
            this._label.set_accelerator(accel);
            dialog.close();
            return Gdk.EVENT_STOP;
        });

        dialog.present();
    }
});

export default class ClipEmojiPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- shortcuts ---
        const keys = new Adw.PreferencesGroup({ title: _('Shortcuts') });
        keys.add(new ShortcutRow(settings, 'toggle-clipboard',
            _('Open clipboard'), _('Default: Super+V')));
        keys.add(new ShortcutRow(settings, 'toggle-emoji',
            _('Open emoji picker'), _('Default: Super+.')));
        page.add(keys);

        // --- behaviour ---
        const behaviour = new Adw.PreferencesGroup({ title: _('Behaviour') });

        const size = new Adw.SpinRow({
            title: _('History size'),
            subtitle: _('Pinned items are kept on top of this limit'),
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 500, step_increment: 5, page_increment: 25,
            }),
        });
        settings.bind('history-size', size, 'value', 0);
        behaviour.add(size);

        const images = new Adw.SwitchRow({
            title: _('Remember images'),
            subtitle: _('Copied images are cached under ~/.cache/clipemoji'),
        });
        settings.bind('cache-images', images, 'active', 0);
        behaviour.add(images);

        const paste = new Adw.SwitchRow({
            title: _('Paste automatically'),
            subtitle: _('Sends Ctrl+V after selecting. Unreliable in XWayland and some Electron apps.'),
        });
        settings.bind('paste-on-select', paste, 'active', 0);
        behaviour.add(paste);

        const indicator = new Adw.SwitchRow({
            title: _('Show panel icon'),
            subtitle: _('Shortcuts keep working when hidden'),
        });
        settings.bind('show-indicator', indicator, 'active', 0);
        behaviour.add(indicator);

        page.add(behaviour);

        // --- privacy ---
        const privacy = new Adw.PreferencesGroup({
            title: _('Privacy'),
            description: _('History is stored unencrypted in your cache directory.'),
        });

        const priv = new Adw.SwitchRow({
            title: _('Pause recording'),
            subtitle: _('Nothing new is added to history while on'),
        });
        settings.bind('private-mode', priv, 'active', 0);
        privacy.add(priv);

        const excluded = new Adw.EntryRow({
            title: _('Never record from (WM_CLASS, comma separated)'),
            text: settings.get_strv('excluded-apps').join(', '),
        });
        excluded.connect('apply', () => {
            settings.set_strv('excluded-apps',
                excluded.get_text().split(',')
                    .map(s => s.trim()).filter(Boolean));
        });
        excluded.set_show_apply_button(true);
        privacy.add(excluded);

        page.add(privacy);
    }
}
