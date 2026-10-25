import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icons/Icon";
import { ago, bytes } from "../lib/format";
import {
  deleteOrphan,
  keepOrphan,
  KeptByRecheck,
  STATE_GROUP,
  unkeepOrphan,
  type Orphan,
  type OrphanScan,
} from "../api/orphans";
import { useDismiss } from "../app/ui";
import { toast } from "../state/store";

type Decision = "del" | "keep";
type Tab = "all" | "open" | Decision;
type Outcome =
  | { kind: "queued" }
  | { kind: "active" }
  | { kind: "deleted" }
  | { kind: "failed"; msg: string }
  | { kind: "kept"; msg: string };

const RECENT_S = 15 * 60;

/** The entry's own name: a folder gets its slash, a state set its torrent's name. */
export function label(o: Orphan): string {
  if (o.kind === "state")
    return o.name || `${o.hash?.slice(0, 6)}…${o.hash?.slice(-4)}`;
  const base = o.path.slice(o.path.lastIndexOf("/") + 1);
  return o.kind === "dir" ? base + "/" : base;
}

/** Where it sits below its scanned folder, "" at the top. */
export function parentRel(o: Orphan): string {
  const dir = o.path.slice(0, o.path.lastIndexOf("/") + 1);
  return dir.startsWith(o.group + "/") ? dir.slice(o.group.length + 1) : "";
}

/** "2 video · 1 subtitle", most first. */
export function contents(o: Orphan): string {
  if (o.kind === "symlink") return "a symbolic link";
  if (o.kind === "state")
    return `${o.files} Transmission ${o.files === 1 ? "file" : "files"}`;
  const t = Object.entries(o.types ?? {}).sort((a, b) => b[1] - a[1]);
  return t.map(([k, n]) => `${n.toLocaleString("en")} ${k}`).join(" · ") || "—";
}

/** One line under the name in the list. */
function sub(o: Orphan): string {
  if (o.kind === "state")
    return `${o.hash?.slice(0, 6)}…${o.hash?.slice(-4)} · ${o.files === 2 ? ".torrent + .resume" : o.path.slice(o.path.lastIndexOf("."))}`;
  return [
    parentRel(o),
    o.kind === "dir" ? `${o.files.toLocaleString("en")} files` : "",
    `changed ${ago(o.mtime)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

const has = (o: Orphan, f: string) => o.flags?.includes(f) ?? false;

/** The plain-language reason it is here, built from what the scan saw. */
export function why(o: Orphan): ReactNode[] {
  const out: ReactNode[] = [];
  const what = o.kind === "file" ? "file" : "folder";
  if (o.kind === "state") {
    out.push(
      <span key="s">
        <b>Transmission’s own leftover files for a torrent it no longer has</b>
        {o.name ? ` (${o.name})` : ""}. Left behind by a removal that did not
        finish. Harmless; deleting tidies the config folder. Any data left
        elsewhere shows up as its own entry.
      </span>,
    );
    return out;
  }
  if (has(o, "match")) {
    out.push(
      <span key="m">
        <b>A loaded torrent has this exact name</b>, with its data in{" "}
        <span className="mono">{o.match}</span>. If that folder is this same
        storage under another name, or the torrent is still downloading into an
        earlier incomplete folder, these are its files: keep it.{" "}
      </span>,
    );
  } else if (o.inside) {
    out.push(
      <span key="i">
        Sits in the folder of <b>{o.inside}</b>, which is still in Transmission,
        but is <b>not one of its files</b>. Usually something unpacked or copied
        in by hand. The torrent itself is not touched.{" "}
      </span>,
    );
  } else if (has(o, "torrent")) {
    out.push(
      <span key="t">
        <b>A .torrent file that is not loaded</b>, probably left in a watch
        folder.{o.name ? ` It is for ${o.name}.` : ""}{" "}
      </span>,
    );
  } else if (has(o, "partial")) {
    out.push(
      <span key="p">
        <b>An unfinished download nobody owns</b>: a torrent removed while it
        was still downloading. It cannot be resumed without its torrent.{" "}
      </span>,
    );
  } else if (o.kind === "symlink") {
    out.push(
      <span key="l">
        <b>A symbolic link nobody owns.</b> Deleting removes the link only,
        never what it points to.{" "}
      </span>,
    );
  } else {
    out.push(
      <span key="n">
        <b>No torrent owns this {what}.</b> Most likely a torrent that was
        removed from the list without its data.{" "}
      </span>,
    );
  }
  if (has(o, "hardlink"))
    out.push(
      <span key="h">
        Every file in it has a second hard link, most likely in a media library:
        deleting removes this path only and <b>frees no space</b>.{" "}
      </span>,
    );
  if (Date.now() / 1000 - o.mtime < RECENT_S)
    out.push(
      <span key="r">
        <b>Changed {ago(o.mtime)}.</b> Something may still be writing it, so
        Keep is the safer call for now.
      </span>,
    );
  return out;
}

const TAG: Record<string, string> = {
  hardlink: "Hardlinked",
  inside: "Inside a torrent",
  partial: "Partial",
  recent: "Changed recently",
  torrent: ".torrent",
  match: "Same name as a loaded torrent",
  state: "Transmission state",
};

/**
 * The review window: every orphan of one scan gets Delete or Keep, one at a time. Undecided
 * ones are never touched. Keep is saved right away; Delete only after the confirm, one
 * request per entry, so each row reports its own outcome.
 */
export function OrphanReview({
  scan,
  onClose,
  onRescan,
}: {
  scan: OrphanScan;
  onClose: () => void;
  onRescan: () => void;
}) {
  const [entries, setEntries] = useState(scan.entries);
  const [dec, setDec] = useState<Record<string, Decision>>({});
  const [cur, setCur] = useState(scan.entries[0]?.id ?? "");
  const [tab, setTab] = useState<Tab>("all");
  const [phase, setPhase] = useState<
    "review" | "confirm" | "deleting" | "done"
  >("review");
  const [outcome, setOutcome] = useState<Record<string, Outcome>>({});
  const stopped = useRef(false);
  // Keep and Undo go out one after another, in key-press order: K then U on the same
  // entry must leave it forgotten, not let the Keep land last.
  const keeps = useRef<Promise<unknown>>(Promise.resolve());
  // Set on mount too: StrictMode mounts, unmounts and mounts again, and a flag only
  // ever cleared would leave a delete run believing the window had closed.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const ref = useDismiss(onClose, phase === "review" || phase === "done");

  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const toDelete = entries.filter((e) => dec[e.id] === "del");
  const kept = entries.filter((e) => dec[e.id] === "keep");
  const decided = toDelete.length + kept.length;
  const visible = entries.filter(
    (e) => tab === "all" || (tab === "open" ? !dec[e.id] : dec[e.id] === tab),
  );
  const total = entries.reduce((a, e) => a + e.size, 0);
  const delSize = toDelete.reduce((a, e) => a + e.size, 0);
  const focus = byId.get(cur) ?? visible[0];

  const decide = (d: Decision | "undo") => {
    if (!focus) return;
    const id = focus.id;
    const was = dec[id];
    const next = { ...dec };
    if (d === "undo") delete next[id];
    else next[id] = d;
    setDec(next);
    if (d !== "undo") {
      // Jump to the next undecided one, so a review is a run of D and K presses.
      const i = entries.findIndex((e) => e.id === id);
      for (let k = 1; k <= entries.length; k++) {
        const e = entries[(i + k) % entries.length];
        if (!next[e.id]) {
          setCur(e.id);
          break;
        }
      }
    }
    // Keep is remembered on the server right away; taking it back forgets it again.
    const send = (call: () => Promise<void>, what: string) => {
      keeps.current = keeps.current
        .then(call)
        .catch((e: Error) => toast(`Could not ${what}: ${e.message}`));
    };
    if (d === "keep" && was !== "keep")
      send(() => keepOrphan(scan.scan_id, id), "remember the Keep");
    if (d !== "keep" && was === "keep")
      send(() => unkeepOrphan(scan.scan_id, id), "forget the Keep");
  };

  useEffect(() => {
    if (phase !== "review") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = visible.findIndex((x) => x.id === focus?.id);
      if (e.key === "ArrowDown" && i < visible.length - 1) {
        e.preventDefault();
        setCur(visible[i + 1].id);
      } else if (e.key === "ArrowUp" && i > 0) {
        e.preventDefault();
        setCur(visible[i - 1].id);
      } else if (e.key === "d") decide("del");
      else if (e.key === "k") decide("keep");
      else if (e.key === "u") decide("undo");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const run = async () => {
    const ids = toDelete.map((e) => e.id);
    stopped.current = false;
    setOutcome(Object.fromEntries(ids.map((id) => [id, { kind: "queued" }])));
    setPhase("deleting");
    for (const id of ids) {
      if (stopped.current || !alive.current) break;
      setOutcome((o) => ({ ...o, [id]: { kind: "active" } }));
      let r: Outcome;
      try {
        await deleteOrphan(scan.scan_id, id);
        r = { kind: "deleted" };
      } catch (e) {
        r =
          e instanceof KeptByRecheck
            ? { kind: "kept", msg: e.message }
            : { kind: "failed", msg: (e as Error).message };
      }
      if (!alive.current) return;
      setOutcome((o) => ({ ...o, [id]: r }));
    }
    if (!alive.current) return;
    // Not attempted after a Stop: back to plain Delete decisions.
    setOutcome((o) =>
      Object.fromEntries(
        Object.entries(o).filter(([, v]) => v.kind !== "queued"),
      ),
    );
    setPhase("done");
  };

  const dismiss = () => {
    const gone = new Set(
      Object.entries(outcome)
        .filter(([, v]) => v.kind === "deleted")
        .map(([id]) => id),
    );
    setEntries((es) => es.filter((e) => !gone.has(e.id)));
    setDec((m) =>
      Object.fromEntries(Object.entries(m).filter(([id]) => !gone.has(id))),
    );
    setOutcome({});
    setPhase("review");
  };

  const outcomes = Object.values(outcome);
  // Answered ones only: the one in flight is not done yet.
  const attempted = outcomes.filter(
    (o) => o.kind !== "queued" && o.kind !== "active",
  ).length;
  const done = outcomes.filter((o) => o.kind === "deleted").length;
  const notDone = outcomes.filter(
    (o) => o.kind === "failed" || o.kind === "kept",
  ).length;
  const active = Object.entries(outcome).find(([, v]) => v.kind === "active");

  return (
    <div className="scrim">
      <div
        ref={ref}
        className="modal rv"
        role="dialog"
        aria-modal="true"
        aria-label="Review orphans"
      >
        <div className="rv-h">
          <span className="t">Review orphans</span>
          <span className="hint">
            {entries.length} found · {bytes(total)} ·{" "}
            {scan.looked.toLocaleString("en")} files looked at
            {scan.hidden_kept ? ` · ${scan.hidden_kept} kept hidden` : ""}
          </span>
          <div className="spacer" style={{ flex: 1 }} />
          <span className="oprog">
            {decided} of {entries.length} decided
            <span className="track">
              <i
                style={{
                  width: `${entries.length ? Math.round((decided / entries.length) * 100) : 0}%`,
                }}
              />
            </span>
          </span>
          <button
            className="btn ghost icon"
            onClick={onClose}
            disabled={phase === "deleting"}
            title="Close"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="rv-b">
          <div className="rv-l">
            <div className="rv-tabs" role="tablist">
              {(
                [
                  ["all", "All", entries.length],
                  ["open", "Undecided", entries.length - decided],
                  ["del", "Delete", toDelete.length],
                  ["keep", "Keep", kept.length],
                ] as const
              ).map(([k, l, n]) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={tab === k}
                  className={tab === k ? "on" : ""}
                  onClick={() => setTab(k)}
                >
                  {l}
                  <span className="num">{n}</span>
                </button>
              ))}
            </div>
            <div className="rv-list">
              {(scan.warnings ?? []).map((w) => (
                <div key={w} className="rv-warn">
                  {w}
                </div>
              ))}
              {visible.length ? null : (
                <div className="hint" style={{ padding: 20 }}>
                  Nothing here.
                </div>
              )}
              {visible.map((e, i) => {
                const head =
                  i === 0 || visible[i - 1].group !== e.group ? (
                    <div className="rv-grp">
                      <Icon
                        name={e.group === STATE_GROUP ? "gear" : "folder"}
                        size={13}
                      />
                      <span className="mono">{e.group}</span>
                    </div>
                  ) : null;
                const d = dec[e.id];
                const r = outcome[e.id];
                const line =
                  r?.kind === "queued"
                    ? "Queued"
                    : r?.kind === "active"
                      ? "Deleting…"
                      : r?.kind === "deleted"
                        ? "Deleted"
                        : r?.kind === "failed"
                          ? `Failed: ${r.msg}`
                          : r?.kind === "kept"
                            ? `Kept: ${r.msg}`
                            : sub(e);
                return (
                  <div key={e.id}>
                    {head}
                    <button
                      className={
                        "rv-it" +
                        (d ? " " + d : "") +
                        (e.id === focus?.id && phase === "review"
                          ? " ocur"
                          : "") +
                        (r?.kind === "deleted" ? " gone" : "") +
                        (r?.kind === "failed" || r?.kind === "kept"
                          ? " failed"
                          : "")
                      }
                      onClick={() => setCur(e.id)}
                    >
                      <span className="rv-mk">
                        {d === "del" ? (
                          <Icon name="trash" />
                        ) : d === "keep" ? (
                          <Icon name="check" />
                        ) : null}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className="n" style={{ display: "block" }}>
                          {label(e)}
                        </span>
                        <span className="s" style={{ display: "block" }}>
                          {line}
                        </span>
                      </span>
                      <span className="sz num">{bytes(e.size)}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="rv-d">
            {focus ? (
              <Detail
                o={focus}
                d={dec[focus.id]}
                onDecide={decide}
                readOnly={phase !== "review"}
              />
            ) : (
              <div className="empty-st">
                <div className="t">All done</div>
              </div>
            )}
          </div>
        </div>
        <div className="rv-f">
          {phase === "deleting" ? (
            <div className="rm-bar">
              <span className="v">
                Deleting {Math.min(attempted + 1, outcomes.length)} of{" "}
                {outcomes.length}
              </span>
              <span className="who">
                {active ? label(byId.get(active[0])!) : ""}
              </span>
              <span className="track">
                <i
                  style={{
                    ["--p" as string]: `${Math.round((attempted / Math.max(outcomes.length, 1)) * 100)}%`,
                  }}
                />
              </span>
              <button
                className="btn sm ghost"
                onClick={() => {
                  stopped.current = true;
                }}
              >
                Stop
              </button>
            </div>
          ) : phase === "done" ? (
            <>
              <div className={"rm-bar done" + (notDone ? " has-fail" : "")}>
                <span className="v">
                  {notDone
                    ? `Deleted ${done} of ${attempted}, ${notDone} not deleted`
                    : `Deleted ${done === 1 ? "1 item" : `${done} items`}`}
                </span>
                <span className="track">
                  <i style={{ ["--p" as string]: "100%" }} />
                </span>
                <button className="btn sm ghost" onClick={dismiss}>
                  Dismiss
                </button>
              </div>
              <div className="spacer" style={{ flex: 1 }} />
              <button className="btn ghost" onClick={onRescan}>
                Scan again
              </button>
            </>
          ) : (
            <>
              <span className="sum">
                <b>{toDelete.length}</b> to delete · {bytes(delSize)}
              </span>
              <span className="sum">
                · <b>{kept.length}</b> to keep
              </span>
              <span className="sum faint">
                · {entries.length - decided} undecided stay as they are
              </span>
              <div className="spacer" style={{ flex: 1 }} />
              <span className="hint">
                Kept paths stay hidden in later scans until they change
              </span>
              <button
                className="btn primary"
                disabled={!toDelete.length}
                style={
                  toDelete.length
                    ? { background: "var(--err)" }
                    : { opacity: 0.5 }
                }
                onClick={() => setPhase("confirm")}
              >
                Delete {toDelete.length || ""}…
              </button>
            </>
          )}
        </div>
      </div>
      {phase === "confirm" ? (
        <Confirm
          items={toDelete}
          size={delSize}
          onBack={() => setPhase("review")}
          onGo={() => void run()}
        />
      ) : null}
    </div>
  );
}

function Detail({
  o,
  d,
  onDecide,
  readOnly,
}: {
  o: Orphan;
  d?: Decision;
  onDecide: (d: Decision | "undo") => void;
  readOnly: boolean;
}) {
  const parent =
    o.kind === "state"
      ? o.path.slice(0, o.path.lastIndexOf("/") + 1)
      : o.group + "/" + parentRel(o);
  return (
    <>
      <div>
        <div className="path">{parent}</div>
        <div className="oname">{label(o)}</div>
      </div>
      <div className="facts">
        <div>
          <span className="k">Size</span>
          <span className="v num">{bytes(o.size)}</span>
        </div>
        {o.kind === "dir" ? (
          <div>
            <span className="k">Files</span>
            <span className="v num">{o.files.toLocaleString("en")}</span>
          </div>
        ) : null}
        <div>
          <span className="k">Last changed</span>
          <span className="v">{ago(o.mtime)}</span>
        </div>
        <div>
          <span className="k">Contents</span>
          <span className="v">{contents(o)}</span>
        </div>
      </div>
      {o.flags?.length ? (
        <div className="oflags">
          {o.flags.map((f) =>
            TAG[f] ? (
              <span key={f} className="oflag">
                {TAG[f]}
              </span>
            ) : null,
          )}
        </div>
      ) : null}
      <div className="why">{why(o)}</div>
      {o.children?.length ? (
        <div className="otree">
          <div className="h">
            <span>Inside</span>
            <span>{o.files.toLocaleString("en")} files</span>
          </div>
          {o.children.map((c) => (
            <div key={c.name} className="r">
              <Icon name={c.dir ? "folder" : "file"} />
              {c.name}
              <span className="num">
                {c.dir ? `${c.files.toLocaleString("en")} files · ` : ""}
                {bytes(c.size)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {readOnly ? null : (
        <div className="decide">
          <button
            className={"btn keep" + (d === "keep" ? " on" : "")}
            onClick={() => onDecide("keep")}
          >
            <Icon name="check" />
            Keep<span className="kbd">K</span>
          </button>
          <button
            className={"btn del" + (d === "del" ? " on" : "")}
            onClick={() => onDecide("del")}
          >
            <Icon name="trash" />
            Delete<span className="kbd">D</span>
          </button>
          <div className="spacer" style={{ flex: 1 }} />
          <span className="hint" style={{ alignSelf: "center" }}>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> move ·{" "}
            <button
              onClick={() => onDecide("undo")}
              disabled={!d}
              style={{ font: "inherit", color: "inherit" }}
            >
              <span className="kbd">U</span> undecide
            </button>
          </span>
        </div>
      )}
    </>
  );
}

function Confirm({
  items,
  size,
  onBack,
  onGo,
}: {
  items: Orphan[];
  size: number;
  onBack: () => void;
  onGo: () => void;
}) {
  const ref = useDismiss(onBack);
  return (
    <div
      className="scrim"
      style={{ zIndex: 20, background: "rgba(0,0,0,.25)" }}
    >
      <div
        ref={ref}
        className="modal"
        style={{ width: 560 }}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm delete"
      >
        <div className="modal-h">
          <span className="t">
            Delete {items.length} {items.length === 1 ? "item" : "items"}
          </span>
          <div className="spacer" />
          <button className="btn ghost icon" onClick={onBack} title="Back">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-b">
          <div>
            Everything you marked Delete, and nothing else. Transmission does
            not know these files, so nothing changes in the list.
          </div>
          <div className="confirm-list">
            {items.map((e) => (
              <div key={e.id}>
                <span className="mono">{e.path}</span>
                <span className="num">{bytes(e.size)}</span>
              </div>
            ))}
          </div>
          <div className="hint" style={{ color: "var(--err)" }}>
            This cannot be undone.
          </div>
        </div>
        <div className="modal-f">
          <div className="spacer" />
          <button className="btn ghost" onClick={onBack}>
            Back to review
          </button>
          <button
            className="btn primary"
            style={{ background: "var(--err)" }}
            onClick={onGo}
          >
            Delete {items.length} · {bytes(size)}
          </button>
        </div>
      </div>
    </div>
  );
}
