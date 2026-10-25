// The orphan finder: the backend's own routes, not daemon RPC. The browser never names a
// path here: a scan returns entries with ids, and keep/delete refer to those ids.
import { basePath } from "../rpc/client";

export interface OrphanChild {
  name: string;
  dir: boolean;
  size: number;
  files: number;
}

export interface Orphan {
  id: string;
  group: string; // the scanned folder, or STATE_GROUP
  path: string;
  kind: "file" | "dir" | "empty" | "symlink" | "state";
  size: number;
  files: number;
  mtime: number;
  flags?: string[];
  inside?: string;
  match?: string;
  name?: string;
  hash?: string;
  types?: Record<string, number>;
  children?: OrphanChild[];
}

export const STATE_GROUP = "Transmission state";

export interface OrphanScan {
  scan_id: string;
  at: number;
  took_ms: number;
  looked: number;
  hidden_kept: number;
  warnings?: string[];
  entries: Orphan[];
}

export interface KeptPath {
  path: string;
  size: number;
  files: number;
  mtime: number;
}

export interface OrphanStatus {
  roots: { path: string; free: number }[];
  config: string;
  kept: KeptPath[];
  last_scan?: number;
}

/** A refusal by the delete's recheck: nothing was removed, and why. */
export class KeptByRecheck extends Error {}

const url = (p: string) => `${basePath()}/api/orphans${p}`;

async function failure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
}

/**
 * null when the finder is not set up. That is the backend's 404, but also anything that is
 * not its JSON: under `make dev` the daemon answers these paths itself.
 */
export async function orphanStatus(): Promise<OrphanStatus | null> {
  const res = await fetch(url(""), { credentials: "same-origin" });
  const json = (res.headers.get("Content-Type") ?? "").includes("json");
  if (res.status === 404 || (res.ok && !json)) return null;
  if (!res.ok) throw new Error(await failure(res));
  return (await res.json()) as OrphanStatus;
}

/**
 * Runs a scan. The answer is NDJSON: progress lines while the backend walks, then one result
 * or error line. Aborting the signal stops the walk on the server too.
 */
export async function scanOrphans(
  onProgress: (looked: number, path: string) => void,
  signal?: AbortSignal,
): Promise<OrphanScan> {
  const res = await fetch(url("/scan"), {
    method: "POST",
    credentials: "same-origin",
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await failure(res));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as {
        progress?: { looked: number; path: string };
        result?: OrphanScan;
        error?: string;
      };
      if (msg.progress) onProgress(msg.progress.looked, msg.progress.path);
      if (msg.error) throw new Error(msg.error);
      if (msg.result) return msg.result;
    }
    if (done) throw new Error("the scan ended without a result");
  }
}

async function post(path: string, method: string, body?: unknown) {
  const res = await fetch(url(path), {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 409) throw new KeptByRecheck(await failure(res));
  if (!res.ok) throw new Error(await failure(res));
}

export const keepOrphan = (scanId: string, id: string) =>
  post("/keep", "POST", { scan_id: scanId, id });

/** Takes one Keep back (scanId and id), or forgets every Keep (no arguments). */
export const forgetKept = (scanId?: string, id?: string) =>
  post("/keep", "DELETE", scanId ? { scan_id: scanId, id } : undefined);

/** Deletes one entry. Rejects with KeptByRecheck when the backend's recheck said no. */
export const deleteOrphan = (scanId: string, id: string) =>
  post("/delete", "POST", { scan_id: scanId, id });
