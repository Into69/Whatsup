#!/bin/sh
# Puts WhatsUp in your app menu: the program in ~/.local/bin, its icon and menu entry in
# ~/.local/share. Run from the folder it came in. To remove it again: ./install.sh --remove
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin="$HOME/.local/bin"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
if [ "${1:-}" = "--remove" ]; then
    rm -f "$bin/whatsup" "$apps/whatsup.desktop" "$icons/whatsup.png"
    echo "WhatsUp removed. Its settings and downloads are in ~/.local/share/whatsup and ~/.cache/whatsup."
    exit 0
fi
mkdir -p "$bin" "$apps" "$icons"
cp "$here/whatsup" "$bin/whatsup"
chmod +x "$bin/whatsup"
cp "$here/whatsup.png" "$icons/whatsup.png"
sed "s#^Exec=.*#Exec=$bin/whatsup#" "$here/whatsup.desktop" > "$apps/whatsup.desktop"
command -v update-desktop-database > /dev/null && update-desktop-database "$apps" 2> /dev/null || true
echo "WhatsUp is in your app menu, and runs as $bin/whatsup."
