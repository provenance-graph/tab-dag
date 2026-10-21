#!/bin/sh
# Zips ./extension into ./release (the manifest's "key" keeps the extension id fixed across reinstalls).
set -e
cd "$(dirname "$0")/.."
v=$(node -p 'require("./extension/manifest.json").version')
out="release/tab-dag-$v.zip"
mkdir -p release && rm -f "$out"
(cd extension && zip -qrX "../$out" .)
zip -qX "$out" LICENSE NOTICE
echo "$out"
