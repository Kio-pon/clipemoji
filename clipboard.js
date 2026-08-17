// Clipboard watching + persistence.
// Selection-tracking approach adapted from Clipboard Indicator (MIT, Tudmotu),
// with a memory-lean registry: text is held inline, images live on disk and are
// never kept in RAM.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

// Ordered by preference: first match wins.
const MIMETYPES = [
    'text/plain;charset=utf-8',
    'UTF8_STRING',
    'text/plain',
    'STRING',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
];

const IMAGE_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/webp': 'webp', 'image/gif': 'gif',
};

// Registry writes are batched; copying rapidly must not thrash the disk.
const WRITE_DEBOUNCE_MS = 600;
// Text longer than this is truncated before storage. Guards against someone
// copying a multi-megabyte file into a JSON registry.
const MAX_TEXT_BYTES = 64 * 1024;

export class ClipboardEntry {
    constructor({ type, text = null, path = null, mimetype = null, favorite = false, ts = 0 }) {
        this.type = type;               // 'text' | 'image'
        this.text = text;
        this.path = path;
        this.mimetype = mimetype;
        this.favorite = favorite;
        this.ts = ts || Date.now();
    }

    get isImage() { return this.type === 'image'; }

    // Cheap identity check used for dedupe.
    equals(other) {
        if (!other || other.type !== this.type) return false;
        return this.type === 'text'
            ? other.text === this.text
            : other.path === this.path;
    }

    label(maxLen = 60) {
        if (this.isImage) return `Image (${(this.mimetype || '').replace('image/', '').toUpperCase()})`;
        const flat = this.text.replace(/\s+/g, ' ').trim();
        return flat.length > maxLen ? flat.slice(0, maxLen) + '…' : flat;
    }

    toJSON() {
        return this.type === 'text'
            ? { t: 'text', c: this.text, f: this.favorite, ts: this.ts }
            : { t: 'image', p: this.path, m: this.mimetype, f: this.favorite, ts: this.ts };
    }

    static fromJSON(o) {
        return o.t === 'text'
            ? new ClipboardEntry({ type: 'text', text: o.c, favorite: !!o.f, ts: o.ts })
            : new ClipboardEntry({ type: 'image', path: o.p, mimetype: o.m, favorite: !!o.f, ts: o.ts });
    }
}

export class ClipboardManager {
    constructor(settings) {
        this._settings = settings;
        this._clipboard = St.Clipboard.get_default();
        this._entries = [];
        this._listeners = new Set();
        this._selectionId = null;
        this._selection = null;
        this._writeTimer = null;
        this._refreshing = false;
        this._destroyed = false;

        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'clipemoji']);
        this._imageDir = GLib.build_filenamev([this._dir, 'images']);
        this._registryFile = Gio.File.new_for_path(
            GLib.build_filenamev([this._dir, 'registry.json']));

        GLib.mkdir_with_parents(this._imageDir, 0o700);

        this._load();
        this._startWatching();
    }

    // --- observers -------------------------------------------------------

    connect_changed(fn) { this._listeners.add(fn); return fn; }
    disconnect_changed(fn) { this._listeners.delete(fn); }
    _emit() { for (const fn of this._listeners) fn(); }

    get entries() { return this._entries; }

    // --- watching --------------------------------------------------------

    _startWatching() {
        this._selection = Shell.Global.get().get_display().get_selection();
        this._selectionId = this._selection.connect('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._onClipboardChanged().catch(logError);
        });
    }

    async _onClipboardChanged() {
        if (this._destroyed) return;
        if (this._settings.get_boolean('private-mode')) return;
        // Re-entrancy guard: our own set_content would otherwise recurse.
        if (this._refreshing) return;

        const focused = Shell.Global.get().display.focusWindow;
        const wmClass = focused?.get_wm_class();
        if (wmClass && this._settings.get_strv('excluded-apps').includes(wmClass))
            return;

        this._refreshing = true;
        try {
            const entry = await this._read();
            if (!entry || this._destroyed) return;

            const existing = this._entries.findIndex(e => e.equals(entry));
            if (existing !== -1) {
                // Already known: promote to most-recent instead of duplicating.
                const [found] = this._entries.splice(existing, 1);
                found.ts = Date.now();
                this._entries.unshift(found);
            } else {
                this._entries.unshift(entry);
                this._trim();
            }
            this._scheduleWrite();
            this._emit();
        } finally {
            this._refreshing = false;
        }
    }

    _read() {
        return new Promise(resolve => {
            const tryType = (i) => {
                if (i >= MIMETYPES.length) { resolve(null); return; }
                let type = MIMETYPES[i];
                this._clipboard.get_content(CLIPBOARD_TYPE, type, (_cb, bytes) => {
                    if (!bytes || bytes.get_size() === 0) { tryType(i + 1); return; }

                    const isImage = type.startsWith('image/');
                    if (isImage) {
                        if (!this._settings.get_boolean('cache-images')) { resolve(null); return; }
                        resolve(this._storeImage(type, bytes));
                        return;
                    }

                    // GNOME can hand back UTF8_STRING for what is really utf-8 text.
                    // https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/8233
                    if (type === 'UTF8_STRING') type = 'text/plain;charset=utf-8';

                    let data = bytes.get_data();
                    if (data.length > MAX_TEXT_BYTES) data = data.slice(0, MAX_TEXT_BYTES);

                    const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
                    if (!text.trim()) { tryType(i + 1); return; }

                    resolve(new ClipboardEntry({ type: 'text', text, mimetype: type }));
                });
            };
            tryType(0);
        });
    }

    _storeImage(mimetype, bytes) {
        const ext = IMAGE_EXT[mimetype] || 'bin';
        const name = `${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`;
        const path = GLib.build_filenamev([this._imageDir, name]);
        try {
            const file = Gio.File.new_for_path(path);
            file.replace_contents(bytes.get_data(), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            return new ClipboardEntry({ type: 'image', path, mimetype });
        } catch (e) {
            logError(e, 'ClipEmoji: failed to cache image');
            return null;
        }
    }

    // --- mutation --------------------------------------------------------

    applyEntry(entry) {
        this._refreshing = true;
        if (entry.isImage) {
            const file = Gio.File.new_for_path(entry.path);
            file.load_contents_async(null, (_file, res) => {
                if (this._destroyed) {
                    this._refreshing = false;
                    return;
                }
                try {
                    const [ok, data] = file.load_contents_finish(res);
                    if (ok) {
                        this._clipboard.set_content(CLIPBOARD_TYPE, entry.mimetype,
                            new GLib.Bytes(data));
                    }
                } catch (e) {
                    logError(e, 'ClipEmoji: failed to apply entry');
                } finally {
                    // Release after the selection event has had a chance to fire.
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                        this._refreshing = false;
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
        } else {
            try {
                this._clipboard.set_text(CLIPBOARD_TYPE, entry.text);
            } catch (e) {
                logError(e, 'ClipEmoji: failed to apply entry');
            } finally {
                // Release after the selection event has had a chance to fire.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    this._refreshing = false;
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    setText(text) {
        this._clipboard.set_text(CLIPBOARD_TYPE, text);
    }

    toggleFavorite(entry) {
        entry.favorite = !entry.favorite;
        this._sort();
        this._scheduleWrite();
        this._emit();
    }

    remove(entry) {
        const i = this._entries.indexOf(entry);
        if (i === -1) return;
        this._entries.splice(i, 1);
        if (entry.isImage) this._deleteFile(entry.path);
        this._scheduleWrite();
        this._emit();
    }

    clear({ keepFavorites = true } = {}) {
        const kept = keepFavorites ? this._entries.filter(e => e.favorite) : [];
        for (const e of this._entries)
            if (e.isImage && !kept.includes(e)) this._deleteFile(e.path);
        this._entries = kept;
        this._scheduleWrite();
        this._emit();
    }

    _trim() {
        const max = this._settings.get_int('history-size');
        // Favourites are pinned and never counted out of the history.
        const pinned = this._entries.filter(e => e.favorite);
        const loose = this._entries.filter(e => !e.favorite);
        if (loose.length <= max) return;
        for (const e of loose.slice(max))
            if (e.isImage) this._deleteFile(e.path);
        this._entries = [...pinned, ...loose.slice(0, max)];
        this._sort();
    }

    _sort() {
        this._entries.sort((a, b) =>
            (b.favorite - a.favorite) || (b.ts - a.ts));
    }

    _deleteFile(path) {
        try { Gio.File.new_for_path(path).delete(null); } catch (_) { /* already gone */ }
    }

    // --- persistence -----------------------------------------------------

    _load() {
        this._registryFile.load_contents_async(null, (_file, res) => {
            if (this._destroyed) return;
            try {
                const [ok, contents] = this._registryFile.load_contents_finish(res);
                if (!ok) return;
                const parsed = JSON.parse(new TextDecoder().decode(contents));
                const loaded = (parsed.entries || [])
                    .map(ClipboardEntry.fromJSON)
                    // Drop entries whose image file was cleaned up externally.
                    .filter(e => !e.isImage || GLib.file_test(e.path, GLib.FileTest.EXISTS));
                if (this._entries.length > 0) {
                    for (const entry of this._entries) {
                        const idx = loaded.findIndex(e => e.equals(entry));
                        if (idx !== -1) loaded.splice(idx, 1);
                        loaded.unshift(entry);
                    }
                }
                this._entries = loaded;
                this._sort();
                this._emit();
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return;
                logError(e, 'ClipEmoji: registry unreadable, starting fresh');
                this._entries = [];
                this._emit();
            }
        });
    }

    _scheduleWrite() {
        if (this._writeTimer) GLib.Source.remove(this._writeTimer);
        this._writeTimer = GLib.timeout_add(GLib.PRIORITY_LOW, WRITE_DEBOUNCE_MS, () => {
            this._writeTimer = null;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    _write() {
        try {
            const payload = JSON.stringify({
                v: 1,
                entries: this._entries.map(e => e.toJSON()),
            });
            this._registryFile.replace_contents(
                new TextEncoder().encode(payload), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            logError(e, 'ClipEmoji: failed to persist registry');
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._writeTimer) {
            GLib.Source.remove(this._writeTimer);
            this._writeTimer = null;
            this._write();   // flush pending changes before unload
        }
        if (this._selectionId) {
            this._selection.disconnect(this._selectionId);
            this._selectionId = null;
        }
        this._selection = null;
        this._listeners.clear();
        this._entries = [];
    }
}
