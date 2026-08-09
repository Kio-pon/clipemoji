# Third-party material

## Clipboard Indicator — MIT

The clipboard selection-tracking approach (watching `MetaDisplay`'s selection
for `SELECTION_CLIPBOARD` and reading through an ordered mimetype list, plus
the `UTF8_STRING` remapping workaround for
[gnome-shell#8233](https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/8233))
was adapted from
[Clipboard Indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator),
© Tudmotu, MIT licensed.

MIT is GPL-compatible, so this derived work ships under GPL-2.0-or-later.

## Unicode CLDR — Unicode License

`emojiData.js` is generated from:

- `emoji-test.txt` v15.1 — © Unicode, Inc.
- CLDR 45 `annotations/en.xml` and `annotationsDerived/en.xml` — © Unicode, Inc.

Distributed under the [Unicode Terms of Use](https://www.unicode.org/copyright.html).
Regenerate with `tools/generate-emoji-data.py`.
