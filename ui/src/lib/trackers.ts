// ─── tracker display names ───
// Announce hostnames rarely match the name a tracker is known by, and several
// trackers announce over unrelated domains. Keys are registrable domains,
// matched by suffix walk, so one entry covers tracker.x.net, t.x.net and x.net
// alike. Several keys may share a value (IPTorrents announces to three
// unrelated domains); each host still gets its own sidebar row.
//
// Names come from public sources only: qbit_manage's config.yml.sample
// `tracker:` section, published announce-domain reports, and the trackers this
// repo's own fixtures and sim announce to. An unmapped host renders unchanged.
export const TRACKER_NAMES: Record<string, string> = {
  // public trackers
  'opentrackr.org': 'OpenTrackr',
  'openbittorrent.com': 'OpenBitTorrent',
  'torrent.eu.org': 'Torrent.eu.org',
  'stealth.si': 'Stealth',
  'tiny-vps.com': 'Tiny-VPS',
  'dler.org': 'Dler',
  'ipv6tracker.org': 'IPv6Tracker',

  // open and freely licensed content
  'debian.org': 'Debian',
  'blender.org': 'Blender',
  'archive.org': 'Archive.org',
  'ubuntu.com': 'Ubuntu',
  'linuxtracker.org': 'LinuxTracker',
  'fedoraproject.org': 'Fedora',
  'nyaa.si': 'Nyaa',
  'tokyotosho.info': 'TokyoTosho',
  'anidex.moe': 'AniDex',

  // private trackers
  'landof.tv': 'BroadcasTheNet',
  'passthepopcorn.me': 'PassThePopcorn',
  'flacsfor.me': 'Redacted',
  'redacted.ch': 'Redacted',
  'myanonamouse.net': 'MyAnonamouse',
  'stackoverflow.tech': 'IPTorrents',
  'empirehost.me': 'IPTorrents',
  'bgp.technology': 'IPTorrents',
  'iptorrents.com': 'IPTorrents',
  'opsfet.ch': 'Orpheus',
  'orpheus.network': 'Orpheus',
  'animebytes.tv': 'AnimeBytes',
  'avistaz.to': 'AvistaZ',
  'cinemaz.to': 'CinemaZ',
  'privatehd.to': 'PrivateHD',
  'beyond-hd.me': 'Beyond-HD',
  'blutopia.cc': 'Blutopia',
  'digitalcore.club': 'DigitalCore',
  'gazellegames.net': 'GGn',
  'hdts-announce.ru': 'HDTorrents',
  'torrentleech.org': 'TorrentLeech',
  'tleechreload.org': 'TorrentLeech',
  'tv-vault.me': 'TV-Vault',
  'torrentdb.net': 'TorrentDB',
  'cartoonchaos.org': 'CartoonChaos',
  'alpharatio.cc': 'AlphaRatio',
  'filelist.io': 'FileList',
  'hd-space.org': 'HD-Space',
  'morethantv.me': 'MoreThanTV',
  'nebulance.io': 'Nebulance',
  'scenehd.org': 'SceneHD',
  'torrentday.com': 'TorrentDay',
  'ncore.pro': 'nCore',
  'superbits.org': 'Superbits',
  'immortalseed.me': 'ImmortalSeed',
  'milkie.cc': 'Milkie',
  'speedapp.io': 'SpeedApp',
  'hdbits.org': 'HDBits',
  'ptfiles.net': 'PTFiles',
  'funfile.org': 'FunFile',
  'bit-hdtv.com': 'Bit-HDTV',
  'torrentbytes.net': 'TorrentBytes',
  'revolutiontt.me': 'RevolutionTT',
}

/**
 * The name a tracker is known by, or the host unchanged when unmapped.
 * Walks the host's domain suffixes so any announce subdomain hits one entry.
 */
export function trackerName(host: string): string {
  let h = host.toLowerCase().replace(/\.$/, '')
  while (h.includes('.')) {
    const hit = TRACKER_NAMES[h]
    if (hit) return hit
    h = h.slice(h.indexOf('.') + 1)
  }
  return host
}
