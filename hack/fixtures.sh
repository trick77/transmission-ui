#!/bin/sh
# Seed the local tm-dev daemon with torrents in every state the UI shows.
# Usage: hack/fixtures.sh   (container must be up: docker compose up -d)
set -eu
R="docker exec tm-dev transmission-remote -n dev:devpass"
X="docker exec tm-dev"

$X sh -c 'mkdir -p /downloads/complete/iso /downloads/complete/radarr /downloads/complete/sonarr/docs /downloads/complete/buffer /downloads/complete/audiobooks /downloads/torrents'

mk() { # mk <name> <size-mb> <subdir>
  $X sh -c "[ -f /downloads/complete/$3/$1.bin ] || head -c $(($2*1024*1024)) /dev/urandom > /downloads/complete/$3/$1.bin"
  $X sh -c "[ -f /downloads/torrents/$1.torrent ] || transmission-create -o /downloads/torrents/$1.torrent -t http://127.0.0.1:1/announce -c 'fixture' /downloads/complete/$3/$1.bin >/dev/null"
}

# seeding, data present, dead tracker (tracker error state)
mk debian-13.1.0-amd64-DVD-1 48 iso
mk Big.Buck.Bunny.2008.2160p 64 radarr
mk Sintel.2010.1080p 24 radarr
mk Cosmos.Laundromat.2015.2160p 40 buffer
mk Blender.4.5.LTS.all.platforms 32 buffer
mk Pride.and.Prejudice.LibriVox 12 audiobooks
mk Apollo.11.Flight.Journal 16 sonarr/docs

for t in debian-13.1.0-amd64-DVD-1:iso Big.Buck.Bunny.2008.2160p:radarr Sintel.2010.1080p:radarr Cosmos.Laundromat.2015.2160p:buffer Blender.4.5.LTS.all.platforms:buffer Pride.and.Prejudice.LibriVox:audiobooks Apollo.11.Flight.Journal:sonarr/docs; do
  n=${t%%:*}; d=${t#*:}
  $R -a /downloads/torrents/$n.torrent -w /downloads/complete/$d >/dev/null || true
done
sleep 2

# labels
$R -t 1 -L linux >/dev/null || true
$R -t 2 -L blender >/dev/null || true
$R -t 3 -L blender >/dev/null || true
$R -t 4 -L blender >/dev/null || true
$R -t 6 -L audiobook >/dev/null || true
$R -t 7 -L archive >/dev/null || true

# stopped
$R -t 6 -S >/dev/null || true
# error: remove data for one torrent then verify → "No data found"
$X rm -f /downloads/complete/sonarr/docs/Apollo.11.Flight.Journal.bin
$R -t 7 -v >/dev/null || true
# downloading 0 %: a magnet with no peers reachable (metadata pending)
$R -a "magnet:?xt=urn:btih:0000000000000000000000000000000000000001&dn=archlinux-2026.08.01-x86_64.iso&tr=http://127.0.0.1:1/announce" -w /downloads/complete/iso >/dev/null || true
$R -t 8 -L linux >/dev/null || true

$R -l
