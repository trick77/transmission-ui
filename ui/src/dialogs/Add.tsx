import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons/Icon'
import { bytes } from '../lib/format'
import { parseTorrent, toBase64, type TorrentInfo } from '../lib/bencode'
import { hostOf, labelCounts } from '../lib/model'
import * as api from '../rpc/methods'
import { refreshNow, toast, useStore } from '../state/store'
import { Modal } from './Dialogs'
import { Opt, Seg, Toggle } from '../app/ui'
import { Chip, FolderChips, useFreeSpace } from './parts'

type Src = { kind: 'file'; name: string; info: TorrentInfo; b64: string } | { kind: 'magnet'; url: string; name: string }

// FileReader rather than File.arrayBuffer(): identical in browsers, and jsdom only implements the former.
function readFile(f: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result as ArrayBuffer); r.onerror = () => reject(r.error); r.readAsArrayBuffer(f) })
}

function magnetName(url: string): string {
  const m = /[?&]dn=([^&]+)/.exec(url)
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : 'magnet link'
}

/** Every magnet link, URL or daemon-side path in a pasted blob, one source each. */
function linksIn(text: string): Src[] {
  return text.split(/\s+/).filter(s => /^(magnet:|https?:\/\/|\/)/.test(s)).map(url => ({ kind: 'magnet', url, name: magnetName(url) }))
}

export function Add({ onClose, initialMagnet, initialFiles }: { onClose: () => void; initialMagnet?: string; initialFiles?: File[] }) {
  const session = useStore(s => s.session)
  const torrents = useStore(s => s.torrents)
  const base = session?.download_dir ?? ''
  const [sources, setSources] = useState<Src[]>([])
  const [text, setText] = useState(initialMagnet ?? '')
  const [dir, setDir] = useState(base)
  const [labels, setLabels] = useState<string[]>([])
  const [start, setStart] = useState(session?.start_added_torrents ?? true)
  const [prio, setPrio] = useState<'-1' | '0' | '1'>('0')
  const [seq, setSeq] = useState(false)
  const [unwanted, setUnwanted] = useState<Set<number>>(new Set())
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!dir && base) setDir(base) }, [base, dir])
  const free = useFreeSpace(dir)
  // Keyed on the array itself: StrictMode runs the effect twice for one drop, and a second
  // drop while the dialog is open arrives as a new array.
  const taken = useRef<File[] | undefined>(undefined)
  useEffect(() => {
    if (!initialFiles?.length || taken.current === initialFiles) return
    taken.current = initialFiles
    void addFiles(initialFiles)
  }, [initialFiles])

  async function addFiles(files: File[] | FileList) {
    const out: Src[] = []
    for (const f of Array.from(files)) {
      try {
        const buf = new Uint8Array(await readFile(f))
        out.push({ kind: 'file', name: f.name, info: parseTorrent(buf), b64: toBase64(buf) })
      } catch { toast(`${f.name}: not a valid .torrent`) }
    }
    setSources(s => [...s, ...out])
  }
  function addText() {
    const links = linksIn(text)
    if (!links.length) return
    setSources(s => [...s, ...links])
    setText('')
  }
  const known = labelCounts(torrents).map(l => l.label)
  const single = sources.length === 1 && sources[0].kind === 'file' ? sources[0] : null
  const files = single ? single.info.files : []
  const selectedBytes = useMemo(() => files.reduce((a, f, i) => a + (unwanted.has(i) ? 0 : f.length), 0), [files, unwanted])
  const pendingText = text.trim().length > 0

  async function submit() {
    // What is still in the box counts too; addText() would only reach `sources` next render.
    const srcs = [...sources, ...linksIn(text)]
    addText()
    if (!srcs.length) return
    setBusy(true)
    let added = 0, dup = 0
    for (const s of srcs) {
      const args: api.AddArgs = { download_dir: dir, paused: !start, labels, bandwidth_priority: Number(prio) as -1 | 0 | 1 }
      if (s.kind === 'file') { args.metainfo = s.b64; if (srcs.length === 1 && unwanted.size) args.files_unwanted = [...unwanted] } else args.filename = s.url
      if (seq) args.sequential_download = true
      try { const r = await api.addTorrent(args); if (r.torrent_duplicate) dup++; else added++ } catch (e) { toast(`Add failed: ${e instanceof Error ? e.message : e}`) }
    }
    setBusy(false)
    refreshNow()
    if (dup) toast(`${dup} already in the list`)
    if (added || dup) onClose()
  }

  const addLabel = () => { const v = draft.trim(); if (v) setLabels(x => x.includes(v) ? x : [...x, v]); setDraft('') }
  return (
    <Modal title="Add torrent" width={680} onClose={onClose}
      footer={<>
        <span className="hint">{sources.length ? `${sources.length} to add` : 'Drop files, paste a magnet link, or browse'}{session?.download_queue_enabled ? ' · added to the download queue' : ''}</span>
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || (!sources.length && !pendingText)} onClick={() => void submit()}><Icon name="plus" />{busy ? 'Adding…' : sources.length > 1 ? `Add ${sources.length} torrents` : 'Add torrent'}</button>
      </>}
      bodyStyle={{ display: 'grid', gap: 18 }}>
      <div className={'drop' + (drag ? ' active' : '')}
        onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); setDrag(false); void addFiles(e.dataTransfer.files) }} onClick={() => fileRef.current?.click()}>
        <Icon name="upload" className="big" />
        <div><b>Drop .torrent files here</b> <span className="faint">or</span> <span style={{ color: 'var(--accent)', fontWeight: 500 }}>browse</span></div>
        <div className="hint">Multiple files are added as separate torrents</div>
        <input ref={fileRef} type="file" accept=".torrent,application/x-bittorrent" multiple hidden onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = '' }} />
      </div>
      {sources.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {sources.map((s, i) => (
            <div key={i} className="opt" style={{ padding: '6px 0' }}>
              <Icon name={s.kind === 'file' ? 'file' : 'magnet'} style={{ color: 'var(--ink-3)' }} />
              <div className="txt"><div className="l" style={{ overflowWrap: 'anywhere' }}>{s.kind === 'file' ? s.info.name : s.name}</div>
                <div className="d">{s.kind === 'file' ? `${bytes(s.info.totalSize)} · ${s.info.files.length} file${s.info.files.length > 1 ? 's' : ''}${s.info.private ? ' · private' : ''}${s.info.announce[0] ? ' · ' + hostOf(s.info.announce[0]) : ''}` : 'Metadata is fetched after adding'}</div></div>
              <button className="btn ghost icon" style={{ width: 26, height: 26 }} onClick={() => setSources(x => x.filter((_, j) => j !== i))}><Icon name="x" size={13} /></button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="field">
        <label>Magnet link or URL</label>
        <div className="input mono"><Icon name="magnet" style={{ color: 'var(--ink-3)' }} />
          <input placeholder="magnet:?xt=urn:btih:… or https://…/file.torrent" value={text} autoFocus={!initialFiles?.length} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addText() }} onBlur={addText} /></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div className="field"><label>Save to</label>
          <div className="input"><Icon name="folder" style={{ color: 'var(--ink-3)' }} /><input value={dir} onChange={e => setDir(e.target.value)} /><span className="unit">{free != null ? `${bytes(free)} free` : ''}</span></div>
          <FolderChips value={dir} onPick={setDir} />
        </div>
        <div className="field"><label>Labels</label>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', minHeight: 32, alignItems: 'center' }}>
            {[...new Set([...known, ...labels])].map(l => <Chip key={l} on={labels.includes(l)} onClick={() => setLabels(x => x.includes(l) ? x.filter(y => y !== l) : [...x, l])}>{l}</Chip>)}
            <input placeholder={known.length ? '+ new' : 'New label, Enter'} style={{ background: 'none', border: 0, outline: 'none', color: 'var(--ink)', minWidth: 60, flex: 1 }}
              value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addLabel() }} />
          </div>
        </div>
      </div>
      {single ? (
        <div>
          <div className="sec" style={{ marginTop: 0 }}>Files · {bytes(selectedBytes)} selected of {bytes(single.info.totalSize)}</div>
          <div className="tree" style={{ background: 'var(--bg)', borderRadius: 'var(--r)', padding: '6px 8px', maxHeight: 220, overflow: 'auto' }}>
            {files.map((f, i) => (
              <div key={i} className="f" style={{ gridTemplateColumns: '18px 16px 1fr 64px' }}>
                <span className={'chk' + (unwanted.has(i) ? '' : ' on')} onClick={() => setUnwanted(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n })} />
                <Icon name="file" size={14} style={{ color: 'var(--ink-3)' }} />
                <span className={'n' + (unwanted.has(i) ? ' faint' : '')} title={f.path}>{f.path.split('/').slice(1).join('/') || f.path}</span>
                <span className={'num r' + (unwanted.has(i) ? ' faint' : '')}>{bytes(f.length)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
        <Opt label="Start when added"><Toggle on={start} onChange={setStart} /></Opt>
        <Opt label="Bandwidth priority"><Seg value={prio} options={[{ v: '-1', l: 'Low' }, { v: '0', l: 'Normal' }, { v: '1', l: 'High' }]} onChange={setPrio} /></Opt>
        <Opt label="Sequential download" desc="Pieces in order, for previewing"><Toggle on={seq} onChange={setSeq} /></Opt>
      </div>
    </Modal>
  )
}
