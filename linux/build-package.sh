#!/bin/sh
# Packs the published Linux app into release/WhatsUp-linux-x64.tar.gz: the program, its icon and
# menu entry, and install.sh. Run on Linux (or WSL) after
#   dotnet publish linux/WhatsUp.Linux.csproj -c Release -o linux/publish
# which can be run on any system.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# Assembled on a Linux file system, for Unix permissions (not on WSL's /mnt/c).
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
dir="$work/whatsup"
mkdir -p "$dir"
cp "$here/publish/whatsup" "$here/whatsup.png" "$here/whatsup.desktop" "$here/install.sh" "$dir/"
chmod 755 "$dir/whatsup" "$dir/install.sh"
chmod 644 "$dir/whatsup.png" "$dir/whatsup.desktop"
mkdir -p "$here/../release"
tar -C "$work" --owner=0 --group=0 -czf "$work/WhatsUp-linux-x64.tar.gz" whatsup
cp "$work/WhatsUp-linux-x64.tar.gz" "$here/../release/WhatsUp-linux-x64.tar.gz"
ls -l "$here/../release/WhatsUp-linux-x64.tar.gz"
