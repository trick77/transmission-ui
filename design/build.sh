#!/bin/sh
# Assemble the mockups from shared fragments (one token set, defined once in src/head.html).
cd "$(dirname "$0")" || exit 1
for p in list detail add settings orphans; do
  cat src/head.html src/shell-top.html src/rows.html "src/page-$p.html" src/tail.html > "$p.html"
done
