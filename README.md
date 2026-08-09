# ClipEmoji

Clipboard history and an emoji picker in one GNOME Shell panel — the `Win+V`
experience, without the pieces that phone home.

- **Super + V** → panel opens on the Clipboard tab
- **Super + .** → panel opens on the Emoji tab

## Why this exists

The maintained options each had a catch on GNOME 46:

| Option | Problem |
|---|---|
| Pano | Latest release supports GNOME ≤ 45; invisible in the store on 46 |
| All-in-One Clipboard | Calls out to Tenor/Klipy/Google/Cloudflare for GIFs and favicons |
| Clipboard Indicator + Emoji Copy | Works, but two separate popups and two shortcuts |

## Design notes

**Fully offline.** The emoji set is generated at build time from Unicode CLDR
`emoji-test.txt` v15.1 and bundled as `emojiData.js` (1,898 glyphs, 104 KB).
v15.1 was chosen to match the installed `fonts-noto-color-emoji` 2.047 — picking
a newer set would render as empty boxes for glyphs the font lacks.

**The grid never blocks the compositor.** Categories build lazily on first view
and populate in 60-button chunks via `GLib.idle_add`. The largest category
(People, 385) would otherwise stall a frame.

**Search is debounced at 120 ms** and capped at 120 results. Prefix matches on
the emoji's name rank above substring matches, so `cat` gives 🐱 before 🎓. A
full scan of all 1,898 entries measures ~1 ms.

**Memory-lean history.** Text lives inline in the registry (truncated at 64 KB);
images are written to `~/.cache/clipemoji/images/` and referenced by path, never
held in RAM. Registry writes are debounced 600 ms so fast copying doesn't thrash
the disk. Pinned entries are exempt from the history cap.

## Privacy

History is stored **unencrypted** at `~/.cache/clipemoji/`. On a machine without
full-disk encryption, anyone with the drive can read it.

Mitigations built in:
- Password managers are excluded by default (KeePassXC, Bitwarden, 1Password, Secrets)
- A pause toggle in the panel toolbar stops recording entirely
- `Clear` wipes history and deletes cached image files, keeping pinned items

## Install

```bash
./sync.sh                 # copy into ~/.local/share/gnome-shell/extensions
# log out and back in     (Wayland cannot reload the shell in place)
gnome-extensions enable clipemoji@kio-pon.github.io
```

## Search

Keywords come from CLDR 45 annotations — all 1,898 emoji carry synonyms, so
`laugh` returns 19 results rather than the one you get from matching display
names alone. An alias table covers colloquial words CLDR does not use (nothing
is annotated "happy").

Matching is **word-prefix**, not substring: `happy` does not match 😒
(`unhappy`), while `lau` still finds 😆🤣😂.

## Performance

| | |
|---|---|
| Install size | 204 KB (124 KB is the emoji table) |
| Submission zip | 60 KB |
| Search across 1,898 emoji | ~1.75 ms |
| Live emoji actors | one category max (~385), not all 1,898 |

Deliberate choices:

- **Grids are never cached.** Switching category destroys the previous grid.
  Caching all nine would leave ~1,900 `St.Button` actors resident for the whole
  session; rebuilding is cheap because population is chunked across idle ticks.
- **No duplicate search index.** Matching runs against the space-joined keyword
  string via `startsWith(w) || includes(' ' + w)`, which gives word-boundary
  semantics without splitting the dataset into a second set of arrays.
- **Images never enter RAM.** They are written to `~/.cache/clipemoji/images/`
  and referenced by path.
- **Registry writes debounce at 600 ms**, so fast copying does not thrash the disk.

## Licence

GPL-2.0-or-later. See [LICENSE](LICENSE) and [THIRD-PARTY.md](THIRD-PARTY.md)
for attribution of the Clipboard Indicator (MIT) and Unicode CLDR material.

## Packaging

```bash
python3 tools/generate-emoji-data.py    # only when refreshing Unicode data
gnome-extensions pack --force --extra-source={clipboard,clipboardPanel,emojiPanel,emojiData}.js .
```

## Compatibility

`metadata.json` declares GNOME **46 and 47** — the versions the API surface was
verified against. GNOME 48 deprecated `St.BoxLayout:vertical` in favour of
`orientation`; before bumping the version list, switch those constructors over
and re-test.
