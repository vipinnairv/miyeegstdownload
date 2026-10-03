#!/bin/sh
# Builds the Chrome Web Store upload: only the files the extension needs.
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
OUT="miyeeindia-gst-return-downloader-$VERSION.zip"
rm -f "$OUT"
zip -r "$OUT" manifest.json background.js content.js popup.html popup.js icons LICENSE
echo "Created $OUT"
