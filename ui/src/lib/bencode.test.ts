import { describe, expect, it } from 'vitest'
import { decode, parseTorrent, toBase64 } from './bencode'

const enc = (s: string) => new TextEncoder().encode(s)

describe('decode', () => {
  it('ints, strings, lists, dicts', () => {
    expect(decode(enc('i42e'))).toBe(42)
    expect(decode(enc('i-7e'))).toBe(-7)
    expect(new TextDecoder().decode(decode(enc('4:spam')) as Uint8Array)).toBe('spam')
    const l = decode(enc('li1ei2ee')) as number[]
    expect(l).toEqual([1, 2])
    const d = decode(enc('d3:cowi3e4:spaml1:ae1:b1:xe')) as Record<string, unknown>
    expect(d.cow).toBe(3)
    expect(d.spam).toHaveLength(1)
  })
  it('rejects malformed input instead of looping', () => {
    for (const s of ['d3:cowi3e4:spaml1:ae1:bee', 'li1e', 'd1:a', 'i12', '5:ab', 'x', '', 'di1ei2ee']) expect(() => decode(enc(s))).toThrow(/invalid bencode/)
    expect(() => parseTorrent(enc('d4:infod4:name1:xee'))).toThrow()
  })
})

describe('parseTorrent', () => {
  it('single-file torrent', () => {
    const t = parseTorrent(enc('d8:announce20:http://t.example/ann7:comment2:hi4:infod6:lengthi1234e4:name8:file.iso7:privatei1eee'))
    expect(t.name).toBe('file.iso')
    expect(t.files).toEqual([{ path: 'file.iso', length: 1234 }])
    expect(t.totalSize).toBe(1234)
    expect(t.announce).toEqual(['http://t.example/ann'])
    expect(t.comment).toBe('hi')
    expect(t.private).toBe(true)
  })
  it('multi-file torrent with announce-list', () => {
    const b = 'd8:announce12:http://a/ann13:announce-listll12:http://a/annel12:http://b/annee4:infod5:filesld6:lengthi10e4:pathl3:dir1:aeed6:lengthi20e4:pathl1:beee4:name4:rootee'
    const t = parseTorrent(enc(b))
    expect(t.name).toBe('root')
    expect(t.files.map(f => f.path)).toEqual(['root/dir/a', 'root/b'])
    expect(t.totalSize).toBe(30)
    expect(t.announce).toEqual(['http://a/ann', 'http://b/ann'])
    expect(t.private).toBe(false)
  })
})

describe('toBase64', () => {
  it('round-trips bytes', () => {
    const buf = new Uint8Array(70_000).map((_, i) => i % 251)
    expect(atob(toBase64(buf)).length).toBe(70_000)
    expect(toBase64(enc('hello'))).toBe('aGVsbG8=')
  })
})
