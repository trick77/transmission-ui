// Minimal bencode decoder, enough to read name/files/announce out of a .torrent for the Add preview.

type BValue = number | Uint8Array | BValue[] | { [k: string]: BValue }

export function decode(buf: Uint8Array): BValue {
  let i = 0
  const td = new TextDecoder()
  const bad = (what: string): never => { throw new Error(`invalid bencode: ${what} at ${i}`) }
  function next(): BValue {
    if (i >= buf.length) bad('unexpected end')
    const c = buf[i]
    if (c === 0x69) { // i<int>e
      const end = buf.indexOf(0x65, i)
      if (end < 0) bad('unterminated int')
      const n = Number(td.decode(buf.subarray(i + 1, end)))
      if (Number.isNaN(n)) bad('int')
      i = end + 1; return n
    }
    if (c === 0x6c) { i++; const out: BValue[] = []; while (buf[i] !== 0x65) { if (i >= buf.length) bad('unterminated list'); out.push(next()) } i++; return out }
    if (c === 0x64) { i++; const out: { [k: string]: BValue } = {}; while (buf[i] !== 0x65) { if (i >= buf.length) bad('unterminated dict'); const k = next(); if (!ArrayBuffer.isView(k)) bad('dict key'); out[td.decode(k as Uint8Array)] = next() } i++; return out }
    const colon = buf.indexOf(0x3a, i)
    if (colon < 0 || c < 0x30 || c > 0x39) bad('string')
    const len = Number(td.decode(buf.subarray(i, colon)))
    if (!Number.isInteger(len) || colon + 1 + len > buf.length) bad('string length')
    const s = buf.subarray(colon + 1, colon + 1 + len); i = colon + 1 + len; return s
  }
  return next()
}

export interface TorrentInfo {
  name: string
  files: { path: string; length: number }[]
  totalSize: number
  announce: string[]
  comment?: string
  private: boolean
}

export function parseTorrent(buf: Uint8Array): TorrentInfo {
  const td = new TextDecoder()
  const root = decode(buf) as { [k: string]: BValue }
  const info = root && typeof root === 'object' && !ArrayBuffer.isView(root) ? root.info as { [k: string]: BValue } | undefined : undefined
  if (!info || !ArrayBuffer.isView(info.name) || (typeof info.length !== 'number' && !Array.isArray(info.files))) throw new Error('not a torrent: missing info.name / length / files')
  const name = td.decode(info.name as Uint8Array)
  const files: TorrentInfo['files'] = []
  if (Array.isArray(info.files)) {
    for (const f of info.files as { [k: string]: BValue }[]) {
      const parts = (f.path as Uint8Array[]).map(p => td.decode(p))
      files.push({ path: [name, ...parts].join('/'), length: f.length as number })
    }
  } else {
    files.push({ path: name, length: info.length as number })
  }
  const announce: string[] = []
  if (root.announce) announce.push(td.decode(root.announce as Uint8Array))
  if (Array.isArray(root['announce-list'])) for (const tier of root['announce-list'] as Uint8Array[][]) for (const u of tier) announce.push(td.decode(u))
  return {
    name, files, totalSize: files.reduce((a, f) => a + f.length, 0), announce: [...new Set(announce)],
    comment: root.comment ? td.decode(root.comment as Uint8Array) : undefined,
    private: info.private === 1,
  }
}

export function toBase64(buf: Uint8Array): string {
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}
