// Clipboard history list. Rows are rebuilt on change; the list is capped by
// history-size so rebuild cost stays bounded. Image rows render a real
// thumbnail via St's file-backed gicon rather than decoding into memory.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const MAX_SEARCH_RESULTS = 100;

// NOTE: activation is a plain JS callback, not a GObject signal. ClipboardEntry
// is a plain class, and marshalling it through a TYPE_OBJECT signal param
// silently drops it - which is why selecting a row used to leave the clipboard
// untouched and paste returned whatever was copied last.
export const ClipboardPanel = GObject.registerClass(
class ClipboardPanel extends St.BoxLayout {
    _init(manager, settings) {
        super._init({ vertical: true, style_class: 'clipemoji-page' });

        this._manager = manager;
        this._settings = settings;
        this._searchTerm = '';
        this._onActivate = null;
        this._rowButtons = [];

        this._scroll = new St.ScrollView({
            style_class: 'clipemoji-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
        });
        this.add_child(this._scroll);

        this._list = new St.BoxLayout({ vertical: true, style_class: 'clipemoji-list' });
        this._scroll.set_child(this._list);

        this._toolbar = this._buildToolbar();
        this.add_child(this._toolbar);

        this._changedHook = this._manager.connect_changed(() => this.refresh());
        this.refresh();
    }

    setOnActivate(fn) { this._onActivate = fn; }
    setFocusSearchHook(fn) { this._focusSearch = fn; }

    _buildToolbar() {
        const bar = new St.BoxLayout({ style_class: 'clipemoji-toolbar' });

        this._privateBtn = new St.Button({
            style_class: 'clipemoji-tool-btn',
            can_focus: true,
            child: new St.Icon({ icon_name: 'security-medium-symbolic', icon_size: 14 }),
        });
        this._privateBtn.set_accessible_name('Pause clipboard recording');
        this._privateBtn.connect('clicked', () => {
            const on = !this._settings.get_boolean('private-mode');
            this._settings.set_boolean('private-mode', on);
            this._syncPrivate();
        });
        bar.add_child(this._privateBtn);

        this._privateLabel = new St.Label({
            text: '', style_class: 'clipemoji-tool-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        bar.add_child(this._privateLabel);

        bar.add_child(new St.Widget({ x_expand: true }));

        const clearBtn = new St.Button({
            style_class: 'clipemoji-tool-btn',
            can_focus: true,
            child: new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 14 }),
        });
        clearBtn.set_accessible_name('Clear history (keeps pinned)');
        clearBtn.connect('clicked', () => this._manager.clear({ keepFavorites: true }));
        bar.add_child(clearBtn);

        this._syncPrivate();
        return bar;
    }

    _syncPrivate() {
        const on = this._settings.get_boolean('private-mode');
        this._privateLabel.text = on ? 'Paused' : '';
        if (on) this._privateBtn.add_style_class_name('active');
        else this._privateBtn.remove_style_class_name('active');
    }

    search(term) {
        this._searchTerm = term.toLowerCase();
        this.refresh();
    }

    refresh() {
        this._list.destroy_all_children();
        this._rowButtons = [];
        this._syncPrivate();

        let entries = this._manager.entries;
        if (this._searchTerm) {
            entries = entries.filter(e =>
                !e.isImage && e.text.toLowerCase().includes(this._searchTerm));
        }
        entries = entries.slice(0, MAX_SEARCH_RESULTS);

        if (!entries.length) {
            this._list.add_child(new St.Label({
                text: this._searchTerm ? 'No matches' : 'Clipboard history is empty',
                style_class: 'clipemoji-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        for (const entry of entries)
            this._list.add_child(this._makeRow(entry));
    }

    _makeRow(entry) {
        const row = new St.BoxLayout({ style_class: 'clipemoji-item', can_focus: true });

        const main = new St.Button({
            style_class: 'clipemoji-item-main',
            x_expand: true,
            can_focus: true,
        });
        const inner = new St.BoxLayout({ style_class: 'clipemoji-item-inner' });

        if (entry.isImage) {
            inner.add_child(new St.Icon({
                gicon: Gio.FileIcon.new(Gio.File.new_for_path(entry.path)),
                icon_size: 32,
                style_class: 'clipemoji-thumb',
            }));
        } else {
            inner.add_child(new St.Icon({
                icon_name: 'text-x-generic-symbolic',
                icon_size: 14,
                style_class: 'clipemoji-item-icon',
            }));
        }

        inner.add_child(new St.Label({
            text: entry.label(),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'clipemoji-item-text',
        }));
        main.set_child(inner);
        main.connect('clicked', () => this._onActivate?.(entry));
        main.connect('key-press-event', (a, e) => this._onRowKey(a, e));
        this._rowButtons.push(main);
        row.add_child(main);

        const pin = new St.Button({
            style_class: entry.favorite
                ? 'clipemoji-row-btn pinned' : 'clipemoji-row-btn',
            can_focus: true,
            child: new St.Icon({ icon_name: 'view-pin-symbolic', icon_size: 14 }),
        });
        pin.set_accessible_name(entry.favorite ? 'Unpin' : 'Pin');
        pin.connect('clicked', () => this._manager.toggleFavorite(entry));
        row.add_child(pin);

        const del = new St.Button({
            style_class: 'clipemoji-row-btn',
            can_focus: true,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 14 }),
        });
        del.set_accessible_name('Delete');
        del.connect('clicked', () => this._manager.remove(entry));
        row.add_child(del);

        return row;
    }

    // Arrow keys stay inside the list instead of leaking focus to the top bar.
    _onRowKey(actor, event) {
        const sym = event.get_key_symbol();
        const i = this._rowButtons.indexOf(actor);
        if (i === -1) return Clutter.EVENT_PROPAGATE;

        let target = null;
        if (sym === Clutter.KEY_Down) target = i + 1;
        else if (sym === Clutter.KEY_Up) target = i - 1;
        else if (sym === Clutter.KEY_Home) target = 0;
        else if (sym === Clutter.KEY_End) target = this._rowButtons.length - 1;
        else if (sym === Clutter.KEY_Escape) { this._focusSearch?.(); return Clutter.EVENT_STOP; }
        else return Clutter.EVENT_PROPAGATE;

        // Moving above the first row returns to the search box.
        if (target < 0) { this._focusSearch?.(); return Clutter.EVENT_STOP; }
        if (target >= this._rowButtons.length) return Clutter.EVENT_STOP;

        this._rowButtons[target].grab_key_focus();
        return Clutter.EVENT_STOP;
    }

    focusFirst() {
        if (!this._rowButtons.length) return false;
        this._rowButtons[0].grab_key_focus();
        return true;
    }

    activateFirst() {
        const main = this._rowButtons[0];
        if (main) main.emit('clicked', 0);
        return !!main;
    }

    destroy() {
        if (this._changedHook) {
            this._manager.disconnect_changed(this._changedHook);
            this._changedHook = null;
        }
        super.destroy();
    }
});
