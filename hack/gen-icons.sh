#!/usr/bin/env bash
# hack/gen-icons.sh
#
# Renders every favicon raster from the three SVG sources in ui/icons/. Run it
# by hand after editing any of them and commit what it writes.
#
# The outputs are COMMITTED rather than generated during the build, so neither
# `npm run build` nor CI needs an image toolchain. That is the whole reason this
# script is not a package.json script.
#
# librsvg does the rasterising, not ImageMagick's own SVG support: the mark is a
# gradient-filled chip, and IM's internal MSVG delegate renders those poorly.
# ImageMagick is used only to re-read the results and assert their grounds.
#
# There is no favicon.ico here. The app declares an SVG icon in <head>, and the
# clients that go looking for a bare /favicon.ico are RSS readers, Windows
# bookmark thumbnails and old IE — none of which this targets. The Go backend
# answers that path with a 404 instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/ui/icons"
OUT="$ROOT/ui/public"
MASTER="$SRC/icon.svg"          # the mark: ships as the tab icon AND renders the PWA rasters

for tool in rsvg-convert magick; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "gen-icons: $tool not found — brew install librsvg imagemagick" >&2
		exit 1
	fi
done
mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- icon.svg: served directly as the modern tab icon ------------------------
# The master itself, unmodified. It is a filled chip, which is already a solid
# object on Safari's light rgb(192,192,192) favourites plate, so it needs no
# light-ground variant of its own.
cp "$MASTER" "$OUT/icon.svg"

# --- transparent, from the master --------------------------------------------
# -b none, and these still come out transparent: the master paints a chip, not a
# canvas, so the four corners outside its rx-4 radius stay clear and the mark
# lands as a chip rather than a square tile. The renderer must not supply a
# ground of its own here or the check below, which is what catches a master that
# grew a background rect back, could never fail.
rsvg-convert -b none -w 192 -h 192 "$MASTER" -o "$OUT/icon-192.png"
rsvg-convert -b none -w 512 -h 512 "$MASTER" -o "$OUT/icon-512.png"

# --- opaque, from the tiled sources -----------------------------------------
# No -b none here, and that is the point: iOS flattens alpha onto black and
# Android fills it with the launcher's own colour, so these two carry the app's
# #1f1f1e edge to edge instead of letting the OS choose.
rsvg-convert -w 180 -h 180 "$SRC/icon-tile.svg" -o "$OUT/apple-touch-icon.png"
rsvg-convert -w 512 -h 512 "$SRC/icon-maskable.svg" -o "$OUT/icon-maskable-512.png"

# --- verify the grounds survived --------------------------------------------
# Rendering can succeed and still produce the wrong thing — a tiled source that
# lost its background rect yields a touch icon iOS flattens onto black; a master
# that GREW one stamps a square of the app's ground onto every tab bar it lands
# in. Either fails silently in a viewer and only shows up on a real device, so
# assert every ground here instead.
#
# The four split two and two, and the halves are not the same decision:
#
#   icon-192/512          transparent — rendered from ui/icons/icon.svg, whose
#                         chip leaves the canvas corners clear.
#   apple-touch/maskable  opaque — from the tiled sources, and deliberately NOT
#                         following the master: iOS flattens alpha onto black
#                         and Android fills it with the launcher's colour, so
#                         these two must carry their own ground whatever the
#                         favicon does.
#
# A mismatch here means a source changed, not that the check needs relaxing.
fail=0
check_alpha() { # <file> <expected true|false>
	local got
	# ImageMagick 7 prints "True"/"False"; 6 printed "true"/"false". Fold the
	# case so this script is not pinned to one major version.
	got="$(magick identify -format '%[opaque]' "$1" | tr '[:upper:]' '[:lower:]')"
	if [[ "$got" != "$2" ]]; then
		echo "gen-icons: $(basename "$1") is opaque=$got, expected $2" >&2
		fail=1
	fi
}
check_alpha "$OUT/icon-192.png" false
check_alpha "$OUT/icon-512.png" false
check_alpha "$OUT/apple-touch-icon.png" true
check_alpha "$OUT/icon-maskable-512.png" true

# icon.svg ships as SVG, so there is no raster to read — render one here just to
# assert it. Two samples, because it has to be a chip and not a tile, and it has
# to be filled: the canvas corner transparent, and a point inside the chip clear
# of the mark fully opaque. Losing the fill is invisible until someone opens
# Safari's favourites bar.
#
# The interior is asserted on ALPHA, not on a hex value: the chip is painted with
# a gradient, so any single sample sits at one arbitrary point on the ramp and a
# hex equality would pin this check to that point and break on every retune.
#
# THE SAMPLE POINT MUST MISS THE MARK, not just land in the chip. At 512 the
# glyph occupies x[6.22,17.78] y[6.06,17.94] in glyph units, and the stem sits
# on the vertical centreline — so the obvious centre-ish sample would land on
# painted #1f1f1e, report alpha 1 and pass even if the chip's gradient fill had
# been lost entirely. (57,256) is glyph (5.0,12.0): inside the chip, in the left
# gutter, clear of stem, chevron and tray.
#
# Alpha alone cannot tell chip from mark (both are opaque), so the sample is
# also asserted to be REDDER than it is blue, which the gradient always is and
# the #1f1f1e mark never is. That catches a chip whose fill went flat or dark
# without pinning the check to one point on the ramp.
#
# -alpha on before both reads. Without it a fully opaque image carries no alpha
# channel, and then %[fx:...a] does not report 1 — the comparisons would be
# measuring ImageMagick's channel bookkeeping rather than the icon.
rsvg-convert -b none -w 512 -h 512 "$OUT/icon.svg" -o "$TMP/icon-favicon.png"
fav_corner="$(magick "$TMP/icon-favicon.png" -alpha on -format '%[fx:p{0,0}.a]' info:)"
fav_ground="$(magick "$TMP/icon-favicon.png" -alpha on -format '%[fx:p{57,256}.a]' info:)"
fav_warm="$(magick "$TMP/icon-favicon.png" -format '%[fx:p{57,256}.r > p{57,256}.b + 0.15]' info:)"
if [[ "$fav_corner" != "0" ]]; then
	echo "gen-icons: icon.svg's canvas corner has alpha $fav_corner, expected 0" >&2
	fail=1
fi
if [[ "$fav_ground" != "1" ]]; then
	echo "gen-icons: icon.svg's chip has alpha $fav_ground, expected 1" >&2
	fail=1
fi
if [[ "$fav_warm" != "1" ]]; then
	echo "gen-icons: icon.svg's chip is not gradient-coloured at the sample point" >&2
	fail=1
fi

[[ "$fail" == 0 ]] || exit 1
echo "gen-icons: wrote $(cd "$OUT" && ls icon-*.png apple-touch-icon.png | tr '\n' ' ')"
