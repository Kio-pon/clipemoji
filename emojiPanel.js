// Emoji picker.
//
// Memory model: exactly one category grid is alive at a time. Switching
// destroys the previous grid rather than caching it - caching all nine would
// leave ~1900 St.Button actors resident for the whole session. Rebuilds are
// cheap because population is chunked across idle ticks.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { EMOJI_CATEGORIES } from './emojiData.js';

const COLS = 10;
const CHUNK = 60;            // buttons appended per idle tick
const MAX_RECENTS = 30;
const MAX_SEARCH_RESULTS = 120;

// CLDR's vocabulary is precise but not colloquial - nobody annotates 😀 with
// "happy". These expand a typed word into the terms CLDR actually uses.
const ALIASES = {
    happy: ['smile', 'grin', 'joy'],
    sad: ['frown', 'cry', 'disappointed', 'pensive'],
    laugh: ['joy', 'laugh', 'grin', 'tear'],
    angry: ['angry', 'rage', 'pout', 'mad'],
    love: ['love', 'heart', 'kiss'],
    thumb: ['thumbs'],
    yes: ['check', 'ok'],
    no: ['cross', 'prohibited', 'no'],
    party: ['party', 'tada', 'celebration'],
    cool: ['sunglasses', 'cool'],
    sleep: ['sleep', 'zzz'],
    sick: ['sick', 'ill', 'nauseated'],
    money: ['money', 'dollar', 'cash'],
    think: ['think', 'thinking'],
    car: ['car', 'automobile'],
};

export const EmojiPanel = GObject.registerClass({
    Signals: { 'picked': { param_types: [GObject.TYPE_STRING] } },
}, class EmojiPanel extends St.BoxLayout {
    _init(settings) {
        super._init({ vertical: true, style_class: 'clipemoji-page' });

        this._settings = settings;
        this._idles = new Set();
        this._lookup = null;         // glyph -> entry, built once on demand
        this._activeCat = null;
        this._buttons = [];          // flat list backing keyboard navigation
        this._searching = false;

        this._tabs = new St.BoxLayout({ style_class: 'clipemoji-cat-bar' });
        this.add_child(this._tabs);

        this._scroll = new St.ScrollView({
            style_class: 'clipemoji-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
        });
        this.add_child(this._scroll);

        // Single reusable host; contents are swapped, the actor is not.
        this._view = new St.BoxLayout({ vertical: true, style_class: 'clipemoji-grid-host' });
        this._scroll.set_child(this._view);

        this._buildTabs();
        this.showCategory(-1);
    }

    setClearSearchHook(fn) { this._onClearSearch = fn; }
    setFocusSearchHook(fn) { this._focusSearch = fn; }

    // --- categories ------------------------------------------------------

    _buildTabs() {
        const defs = [{ name: 'Recent', icon: 'document-open-recent-symbolic', idx: -1 }]
            .concat(EMOJI_CATEGORIES.map((c, i) => ({ name: c.name, icon: c.icon, idx: i })));

        this._tabButtons = defs.map(def => {
            const btn = new St.Button({
                style_class: 'clipemoji-cat-btn',
                can_focus: true,
                child: new St.Icon({ icon_name: def.icon, icon_size: 16 }),
            });
            btn.set_accessible_name(def.name);
            btn.connect('clicked', () => {
                this._onClearSearch?.();
                this.showCategory(def.idx);
            });
            this._tabs.add_child(btn);
            return { def, btn };
        });
    }

    showCategory(idx) {
        this._searching = false;
        this._activeCat = idx;

        for (const { btn } of this._tabButtons)
            btn.remove_style_pseudo_class('selected');
        this._tabButtons.find(t => t.def.idx === idx)?.btn.add_style_pseudo_class('selected');

        this._swapContents(idx === -1 ? this._recentList() : EMOJI_CATEGORIES[idx].emojis);
    }

    // Tear down the old grid, then build the new one. Freeing first keeps peak
    // actor count at one category rather than two.
    _swapContents(list) {
        this._cancelBuilds();
        this._buttons = [];
        this._view.destroy_all_children();
        this._populate(this._view, list);
        this._scroll.vadjustment?.set_value(0);
    }

    _glyphLookup() {
        if (this._lookup) return this._lookup;
        this._lookup = new Map();
        for (const cat of EMOJI_CATEGORIES)
            for (const e of cat.emojis) this._lookup.set(e[0], e);
        return this._lookup;
    }

    _recentList() {
        const recents = this._settings.get_strv('recent-emojis');
        if (!recents.length) return [];
        const lookup = this._glyphLookup();
        return recents.map(g => lookup.get(g)).filter(Boolean);
    }

    // --- grid building ---------------------------------------------------

    _cancelBuilds() {
        for (const id of this._idles) GLib.Source.remove(id);
        this._idles.clear();
    }

    _populate(container, list) {
        if (!list.length) {
            container.add_child(new St.Label({
                text: this._searching ? 'No matches' : 'Nothing here yet',
                style_class: 'clipemoji-empty',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        let i = 0;
        let row = null;
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const end = Math.min(i + CHUNK, list.length);
            for (; i < end; i++) {
                if (i % COLS === 0) {
                    row = new St.BoxLayout({ style_class: 'clipemoji-row' });
                    container.add_child(row);
                }
                const btn = this._makeButton(list[i]);
                this._buttons.push(btn);
                row.add_child(btn);
            }
            if (i >= list.length) {
                this._idles.delete(id);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._idles.add(id);
    }

    _makeButton([glyph, name]) {
        const btn = new St.Button({
            style_class: 'clipemoji-emoji',
            can_focus: true,
            label: glyph,
        });
        btn.set_accessible_name(name);
        btn.connect('clicked', () => {
            this._remember(glyph);
            this.emit('picked', glyph);
        });
        btn.connect('key-press-event', (a, e) => this._onGridKey(a, e));
        return btn;
    }

    // Arrow keys stay inside the grid instead of leaking focus to the top bar.
    _onGridKey(actor, event) {
        const sym = event.get_key_symbol();
        const i = this._buttons.indexOf(actor);
        if (i === -1) return Clutter.EVENT_PROPAGATE;
        const n = this._buttons.length;

        let target = null;
        switch (sym) {
            case Clutter.KEY_Right: target = i + 1; break;
            case Clutter.KEY_Left:  target = i - 1; break;
            case Clutter.KEY_Down:  target = i + COLS; break;
            case Clutter.KEY_Up:    target = i - COLS; break;
            case Clutter.KEY_Home:  target = 0; break;
            case Clutter.KEY_End:   target = n - 1; break;
            case Clutter.KEY_Escape:
                this._focusSearch?.();
                return Clutter.EVENT_STOP;
            default:
                return Clutter.EVENT_PROPAGATE;
        }

        // Up out of the first row returns to the search box; every other
        // out-of-range move is clamped so focus stays in the grid.
        if (sym === Clutter.KEY_Up && target < 0) {
            this._focusSearch?.();
            return Clutter.EVENT_STOP;
        }
        if (target < 0 || target >= n) return Clutter.EVENT_STOP;

        this._buttons[target].grab_key_focus();
        return Clutter.EVENT_STOP;
    }

    focusFirst() {
        if (!this._buttons.length) return false;
        this._buttons[0].grab_key_focus();
        return true;
    }

    _remember(glyph) {
        const recents = this._settings.get_strv('recent-emojis')
            .filter(g => g !== glyph);
        recents.unshift(glyph);
        this._settings.set_strv('recent-emojis', recents.slice(0, MAX_RECENTS));
    }

    // --- search ----------------------------------------------------------

    // Word-prefix match against the space-joined keyword string. Testing
    // startsWith plus ' '+term gives word-boundary semantics without splitting
    // the dataset into a second set of arrays: "happy" misses "unhappy", while
    // "lau" still finds "laugh".
    static _matches(keywords, groups) {
        return groups.every(alts =>
            alts.some(a => keywords.startsWith(a) || keywords.includes(' ' + a)));
    }

    search(term) {
        if (!term) {
            this.showCategory(this._activeCat ?? -1);
            return;
        }

        this._searching = true;
        for (const { btn } of this._tabButtons)
            btn.remove_style_pseudo_class('selected');

        const words = term.toLowerCase().split(/\s+/).filter(Boolean);
        const groups = words.map(w => [w, ...(ALIASES[w] || [])]);

        const exact = [], partial = [];
        outer:
        for (const cat of EMOJI_CATEGORIES) {
            for (const entry of cat.emojis) {
                if (!EmojiPanel._matches(entry[2], groups)) continue;
                (entry[1].toLowerCase().startsWith(words[0]) ? exact : partial).push(entry);
                if (exact.length + partial.length >= MAX_SEARCH_RESULTS * 2) break outer;
            }
        }

        this._swapContents([...exact, ...partial].slice(0, MAX_SEARCH_RESULTS));
    }

    activateFirst() {
        const btn = this._buttons[0];
        if (btn) btn.emit('clicked', 0);
        return !!btn;
    }

    destroy() {
        this._cancelBuilds();
        this._buttons = [];
        this._lookup = null;
        super.destroy();
    }
});
