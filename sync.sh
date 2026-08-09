#!/usr/bin/env bash
# Compile the schema and install into the user extensions directory.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/clipemoji@kio-pon.github.io"

glib-compile-schemas "$SRC/schemas"
mkdir -p "$DEST"
rsync -a --delete --exclude '.git' --exclude 'sync.sh' "$SRC"/ "$DEST"/
echo "Installed to $DEST"
echo "Log out and back in, then: gnome-extensions enable clipemoji@kio-pon.github.io"
