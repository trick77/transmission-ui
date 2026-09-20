#!/bin/sh
# Assemble the four mockups from shared fragments (one token set, defined once in src/head.html).
cd "$(dirname "$0")"
for p in list detail add settings; do
  cat src/head.html src/shell-top.html src/rows.html "src/page-$p.html" src/tail.html > "$p.html"
done
