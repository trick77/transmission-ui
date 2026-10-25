import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons/Icon";
import { ago, bytes } from "../lib/format";
import {
  forgetKept,
  orphanStatus,
  scanOrphans,
  type OrphanStatus,
} from "../api/orphans";
import { Opt, Sec } from "../app/ui";
import { set, toast } from "../state/store";

/** The setup the finder needs, as the snippet the empty state shows. */
const SETUP = `user: "1000:1000"                 # the daemon's PUID:PGID
volumes:
  - /srv/torrents:/data/torrents   # same paths the daemon sees
  - /srv/transmission:/config
environment:
  BACKEND_DATA_ROOTS: /data/torrents
  BACKEND_DAEMON_CONFIG: /config`;

/**
 * Settings → Maintenance → Orphaned files: what gets scanned, the remembered Keeps, and
 * the Scan button. The review itself is its own window (OrphanReview), opened with the result.
 */
export function OrphansSection({ autoScan }: { autoScan?: boolean }) {
  const [status, setStatus] = useState<OrphanStatus | null | undefined>();
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState<{
    looked: number;
    path: string;
  } | null>(null);
  const [clean, setClean] = useState<{ looked: number; hidden: number }>();
  const [showKept, setShowKept] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const load = () =>
    orphanStatus().then(setStatus, (e: Error) => setError(e.message));

  const scan = async () => {
    setError("");
    setClean(undefined);
    setScanning({ looked: 0, path: "" });
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await scanOrphans(
        (looked, path) => setScanning({ looked, path }),
        ac.signal,
      );
      if (res.entries.length) {
        set({ dialog: { kind: "orphan-review", scan: res } });
        return;
      }
      setClean({ looked: res.looked, hidden: res.hidden_kept });
      void load();
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message);
    } finally {
      if (abort.current === ac) abort.current = null;
      setScanning(null);
    }
  };

  useEffect(() => {
    void load().then(() => {
      if (autoScan) void scan();
    });
    // The section closing mid-scan stops the walk on the server too.
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === undefined && !error)
    return <div className="hint">Loading…</div>;
  if (status === null) {
    return (
      <div className="empty-st">
        <Icon name="folder" size={28} style={{ color: "var(--ink-3)" }} />
        <div className="t">Folders are not mounted</div>
        <div style={{ maxWidth: 440 }}>
          Finding orphaned files needs the transmission-ui container to see the
          folders the daemon writes to (its data and its config folder), and
          permission to delete in them.
        </div>
        <div className="howto">{SETUP}</div>
        <div className="hint">Documented in README, “Orphaned files”.</div>
      </div>
    );
  }
  if (scanning) {
    return (
      <div className="empty-st">
        <div className="spin" />
        <div className="t">Scanning</div>
        <div className="num">{scanning.looked.toLocaleString("en")} files</div>
        <div className="hint mono">{scanning.path}</div>
        <div className="hint" style={{ maxWidth: 420 }}>
          Reads names and sizes only. The review opens when it is done.
        </div>
        <button className="btn" onClick={() => abort.current?.abort()}>
          Stop
        </button>
      </div>
    );
  }
  const kept = status?.kept ?? [];
  return (
    <>
      <div className="hint" style={{ marginBottom: 10 }}>
        Finds files and folders that no torrent in Transmission owns: data left
        behind by removed torrents, abandoned partial downloads, stray extras,
        and Transmission’s own leftover .torrent and .resume files. You decide
        on each one; nothing is deleted without that.
      </div>
      {error ? (
        <div className="hint" style={{ color: "var(--err)", marginBottom: 6 }}>
          {error}
        </div>
      ) : null}
      {clean ? (
        <div className="empty-st" style={{ padding: "18px 0" }}>
          <Icon name="check" size={28} style={{ color: "var(--ink-3)" }} />
          <div className="t">Nothing new</div>
          <div>
            Every file belongs to a torrent
            {clean.hidden ? ", or is one you kept before" : ""}.
          </div>
          <div className="hint">
            {clean.looked.toLocaleString("en")} files looked at
            {clean.hidden ? ` · ${clean.hidden} kept paths hidden` : ""}
          </div>
        </div>
      ) : null}
      {status ? (
        <>
          <Sec first={!clean}>Scanned</Sec>
          {status.roots.map((r) => (
            <Opt
              key={r.path}
              label={<span className="mono">{r.path}</span>}
              desc={r.free ? `${bytes(r.free)} free` : undefined}
            >
              {null}
            </Opt>
          ))}
          <Opt
            label={<span className="mono">{status.config}</span>}
            desc="Transmission state: torrents/, resume/"
          >
            {null}
          </Opt>
          <Sec>Remembered</Sec>
          <Opt
            label={
              kept.length
                ? `${kept.length} ${kept.length === 1 ? "path" : "paths"} kept in earlier reviews`
                : "Nothing kept yet"
            }
            desc="Kept paths stay hidden from scans until they change"
          >
            {kept.length ? (
              <>
                <button
                  className="btn sm ghost"
                  onClick={() => setShowKept((v) => !v)}
                >
                  {showKept ? "Hide" : "Show"}
                </button>
                <button
                  className="btn sm ghost"
                  onClick={() =>
                    void forgetKept().then(
                      () => {
                        setShowKept(false);
                        void load();
                      },
                      (e: Error) => toast(`Forget failed: ${e.message}`),
                    )
                  }
                >
                  Forget all
                </button>
              </>
            ) : null}
          </Opt>
          {showKept ? (
            <div className="kept-list mono">
              {kept.map((k) => (
                <span key={k.path}>{k.path}</span>
              ))}
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 18,
            }}
          >
            <span className="hint">
              {status.last_scan
                ? `Last scan ${ago(status.last_scan)}`
                : "No scan since the backend started"}
            </span>
            <div className="spacer" />
            <button className="btn primary" onClick={() => void scan()}>
              <Icon name="search" />
              Scan
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
