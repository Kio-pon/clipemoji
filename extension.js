// ClipEmoji - unified clipboard history + emoji picker for GNOME Shell.
// Clipboard selection tracking adapted from Clipboard Indicator (MIT, Tudmotu).
// Everything runs locally: no network access, no telemetry.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ClipboardManager } from './clipboard.js';
import { ClipboardPanel } from './clipboardPanel.js';
import { EmojiPanel } from './emojiPanel.js';

const TAB_CLIPBOARD = 0;
const TAB_EMOJI = 1;

const SEARCH_DEBOUNCE_MS = 120;

const ClipEmojiIndicator = GObject.registerClass(
class ClipEmojiIndicator extends PanelMenu.Button {
    _init(manager, settings) {
        super._init(0.5, 'ClipEmoji', false);

        this._manager = manager;
        this._settings = settings;
        this._tab = TAB_CLIPBOARD;
        this._searchTimer = null;

        this.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        }));

        this._buildMenu();

        this._openStateId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open) this._onOpened();
            else this._onClosed();
        });
    }

    _buildMenu() {
        // A single non-reactive item hosts the whole custom UI, so PopupMenu's
        // own row handling never fights our buttons.
        const host = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'clipemoji-host',
        });
        // Append, never assign: the shell's own popup-menu-content class is what
        // paints the opaque background. Replacing it leaves the panel see-through.
        this.menu.box.add_style_class_name('clipemoji-menu-box');

        const root = new St.BoxLayout({ vertical: true, style_class: 'clipemoji-root' });

        // --- header: tabs + search ---
        const header = new St.BoxLayout({ style_class: 'clipemoji-header' });

        this._tabBar = new St.BoxLayout({ style_class: 'clipemoji-tabs' });
        this._clipTab = this._makeTab('Clipboard', 'edit-paste-symbolic', TAB_CLIPBOARD);
        this._emojiTab = this._makeTab('Emoji', 'face-smile-symbolic', TAB_EMOJI);
        header.add_child(this._tabBar);
        root.add_child(header);

        this._search = new St.Entry({
            style_class: 'clipemoji-search',
            hint_text: 'Search…',
            can_focus: true,
            x_expand: true,
        });
        this._search.set_primary_icon(
            new St.Icon({ icon_name: 'edit-find-symbolic', icon_size: 14 }));
        this._search.clutter_text.connect('text-changed', () => this._onSearchChanged());
        this._search.clutter_text.connect('activate', () => this._onSearchActivate());
        this._search.clutter_text.connect('key-press-event', (_a, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Escape) {
                if (this._search.text) { this._search.set_text(''); return Clutter.EVENT_STOP; }
                this.menu.close();
                return Clutter.EVENT_STOP;
            }
            // Down drops from the search box into the results.
            if (sym === Clutter.KEY_Down) {
                const page = this._tab === TAB_CLIPBOARD
                    ? this._clipboardPage : this._emojiPage;
                if (page.focusFirst()) return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        root.add_child(this._search);

        // --- pages ---
        const focusSearch = () => global.stage.set_key_focus(this._search.clutter_text);

        this._clipboardPage = new ClipboardPanel(this._manager, this._settings);
        this._clipboardPage.setOnActivate(entry => {
            this._manager.applyEntry(entry);
            this._closeAndMaybePaste();
        });
        this._clipboardPage.setFocusSearchHook(focusSearch);
        root.add_child(this._clipboardPage);

        this._emojiPage = new EmojiPanel(this._settings);
        this._emojiPage.setClearSearchHook(() => this._search.set_text(''));
        this._emojiPage.setFocusSearchHook(focusSearch);
        this._emojiPage.connect('picked', (_p, glyph) => {
            this._manager.setText(glyph);
            this._closeAndMaybePaste();
        });
        this._emojiPage.visible = false;
        root.add_child(this._emojiPage);

        host.add_child(root);
        this.menu.addMenuItem(host);
    }

    _makeTab(label, iconName, id) {
        const btn = new St.Button({
            style_class: 'clipemoji-tab',
            can_focus: true,
            x_expand: true,
        });
        const box = new St.BoxLayout({ style_class: 'clipemoji-tab-inner' });
        box.add_child(new St.Icon({ icon_name: iconName, icon_size: 14 }));
        box.add_child(new St.Label({
            text: label, y_align: Clutter.ActorAlign.CENTER,
        }));
        btn.set_child(box);
        btn.connect('clicked', () => this.setTab(id));
        this._tabBar.add_child(btn);
        return btn;
    }

    setTab(id) {
        this._tab = id;
        this._clipboardPage.visible = id === TAB_CLIPBOARD;
        this._emojiPage.visible = id === TAB_EMOJI;

        this._clipTab.remove_style_pseudo_class('selected');
        this._emojiTab.remove_style_pseudo_class('selected');
        (id === TAB_CLIPBOARD ? this._clipTab : this._emojiTab)
            .add_style_pseudo_class('selected');

        this._search.hint_text = id === TAB_CLIPBOARD
            ? 'Search clipboard…' : 'Search emoji…';

        // Re-run the current query against the newly visible page.
        this._applySearch(this._search.get_text());
    }

    _onSearchChanged() {
        if (this._searchTimer) GLib.Source.remove(this._searchTimer);
        this._searchTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SEARCH_DEBOUNCE_MS, () => {
                this._searchTimer = null;
                this._applySearch(this._search.get_text());
                return GLib.SOURCE_REMOVE;
            });
    }

    _applySearch(text) {
        const term = (text || '').trim();
        if (this._tab === TAB_CLIPBOARD) this._clipboardPage.search(term);
        else this._emojiPage.search(term);
    }

    _onSearchActivate() {
        if (this._searchTimer) {
            GLib.Source.remove(this._searchTimer);
            this._searchTimer = null;
            this._applySearch(this._search.get_text());
        }
        const page = this._tab === TAB_CLIPBOARD ? this._clipboardPage : this._emojiPage;
        page.activateFirst();
    }

    openOnTab(id) {
        this.setTab(id);
        this.menu.open();
    }

    _onOpened() {
        this._search.set_text('');
        this.setTab(this._tab);
        // Focus must wait for the menu's own open animation to settle.
        this._focusTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._focusTimer = null;
            global.stage.set_key_focus(this._search.clutter_text);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onClosed() {
        if (this._searchTimer) {
            GLib.Source.remove(this._searchTimer);
            this._searchTimer = null;
        }
        if (this._focusTimer) {
            GLib.Source.remove(this._focusTimer);
            this._focusTimer = null;
        }
    }

    _closeAndMaybePaste() {
        this.menu.close();
        if (!this._settings.get_boolean('paste-on-select')) return;
        // Give focus time to return to the previously active window.
        this._pasteTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._pasteTimer = null;
            this._sendPaste();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPaste() {
        try {
            const seat = Clutter.get_default_backend().get_default_seat();
            const vd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const t = global.get_current_time();
            vd.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            vd.notify_keyval(t, Clutter.KEY_v, Clutter.KeyState.PRESSED);
            vd.notify_keyval(t, Clutter.KEY_v, Clutter.KeyState.RELEASED);
            vd.notify_keyval(t, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
        } catch (e) {
            logError(e, 'ClipEmoji: synthetic paste failed');
        }
    }

    destroy() {
        if (this._openStateId) {
            this.menu.disconnect(this._openStateId);
            this._openStateId = null;
        }
        for (const key of ['_searchTimer', '_focusTimer', '_pasteTimer']) {
            if (this[key]) { GLib.Source.remove(this[key]); this[key] = null; }
        }
        super.destroy();
    }
});

export default class ClipEmojiExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._manager = new ClipboardManager(this._settings);
        this._indicator = new ClipEmojiIndicator(this._manager, this._settings);

        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
        this._syncIndicatorVisibility();

        this._visibilityId = this._settings.connect('changed::show-indicator',
            () => this._syncIndicatorVisibility());

        this._addKeybinding('toggle-clipboard', TAB_CLIPBOARD);
        this._addKeybinding('toggle-emoji', TAB_EMOJI);
    }

    _syncIndicatorVisibility() {
        this._indicator.visible = this._settings.get_boolean('show-indicator');
    }

    _addKeybinding(key, tab) {
        Main.wm.addKeybinding(
            key,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => {
                if (this._indicator.menu.isOpen) this._indicator.menu.close();
                else this._indicator.openOnTab(tab);
            });
    }

    disable() {
        Main.wm.removeKeybinding('toggle-clipboard');
        Main.wm.removeKeybinding('toggle-emoji');

        if (this._visibilityId) {
            this._settings.disconnect(this._visibilityId);
            this._visibilityId = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._manager?.destroy();
        this._manager = null;
        this._settings = null;
    }
}
