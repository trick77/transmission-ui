import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { OrphansSection } from "./Orphans";
import { Dialogs } from "./Dialogs";
import { contents, label, OrphanReview, parentRel, why } from "./OrphanReview";
import { get, set } from "../state/store";
import {
  defaultSession,
  installFakeDaemon,
  orphanScan,
  orphanStatus,
  type FakeDaemon,
} from "../test/fakeDaemon";
import {
  KeptByRecheck,
  orphanStatus as fetchStatus,
  scanOrphans,
  type Orphan,
} from "../api/orphans";

let daemon: FakeDaemon;
afterEach(() => {
  daemon?.restore();
  set({ dialog: { kind: "none" }, toast: "" });
});

const calls = (path: string, method?: string) =>
  daemon.orphans.calls.filter(
    (c) => c.path === path && (!method || c.method === method),
  );

describe("Settings entry", () => {
  it("explains the setup when the finder is not mounted", async () => {
    daemon = installFakeDaemon();
    render(<OrphansSection />);
    expect(
      await screen.findByText("Folders are not mounted"),
    ).toBeInTheDocument();
    expect(screen.getByText(/BACKEND_DATA_ROOTS/)).toBeInTheDocument();
  });

  it("lists the scanned folders and forgets the remembered Keeps", async () => {
    daemon = installFakeDaemon({
      orphans: {
        status: orphanStatus({
          kept: [{ path: "/data/torrents/old", size: 1, files: 1, mtime: 1 }],
          last_scan: Math.floor(Date.now() / 1000) - 3600,
        }),
      },
    });
    render(<OrphansSection />);
    expect(await screen.findByText("/data/torrents")).toBeInTheDocument();
    expect(screen.getByText("412 GB free")).toBeInTheDocument();
    expect(screen.getByText("Last scan 1h ago")).toBeInTheDocument();
    expect(
      screen.getByText("1 path kept in earlier reviews"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByText("/data/torrents/old")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forget all" }));
    await waitFor(() => expect(calls("/forget", "POST")).toHaveLength(1));
    expect(calls("/forget")[0].body).toBeUndefined();
  });

  it("opens the review with the scan result", async () => {
    daemon = installFakeDaemon({ orphans: { status: orphanStatus() } });
    render(<OrphansSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Scan/ }));
    await waitFor(() => expect(get().dialog.kind).toBe("orphan-review"));
    const d = get().dialog;
    expect(d.kind === "orphan-review" && d.scan.entries).toHaveLength(4);
  });

  it("shows what a clean scan could not read", async () => {
    daemon = installFakeDaemon({
      orphans: {
        status: orphanStatus(),
        scan: orphanScan({
          entries: [],
          warnings: [
            "could not read /data/torrents/locked, skipped: permission denied",
          ],
        }),
      },
    });
    render(<OrphansSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Scan/ }));
    expect(
      await screen.findByText(/could not read \/data\/torrents\/locked/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nothing new in what could be read."),
    ).toBeInTheDocument();
  });

  it("says so when nothing new turned up, and scans on its own when asked", async () => {
    daemon = installFakeDaemon({
      orphans: {
        status: orphanStatus(),
        scan: orphanScan({ entries: [], hidden_kept: 2 }),
      },
    });
    render(<OrphansSection autoScan />);
    expect(await screen.findByText("Nothing new")).toBeInTheDocument();
    expect(screen.getByText(/2 kept paths hidden/)).toBeInTheDocument();
    expect(get().dialog.kind).toBe("none");
  });

  it("shows a scan's error", async () => {
    daemon = installFakeDaemon({
      orphans: { status: orphanStatus(), scanError: "daemon unreachable" },
    });
    render(<OrphansSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Scan/ }));
    expect(await screen.findByText("daemon unreachable")).toBeInTheDocument();
  });

  it("shows progress and stops", async () => {
    daemon = installFakeDaemon({ orphans: { status: orphanStatus() } });
    // A scan that streams one progress line and then waits for the Stop. Every other
    // route answers here too: the fake daemon's fetch is this same spy.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((u, init) => {
      if (!String(u).endsWith("/scan"))
        return Promise.resolve(Response.json(orphanStatus()));
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    progress: { looked: 42, path: "/data/x" },
                  }) + "\n",
                ),
              );
              init?.signal?.addEventListener("abort", () =>
                c.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
        ),
      );
    });
    render(<OrphansSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Scan/ }));
    expect(await screen.findByText("42 files")).toBeInTheDocument();
    expect(screen.getByText("/data/x")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(
      await screen.findByRole("button", { name: /Scan/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/aborted/)).toBeNull();
    spy.mockRestore();
  });

  it("is a Settings section under Maintenance", async () => {
    daemon = installFakeDaemon({ orphans: { status: orphanStatus() } });
    set({ session: defaultSession() });
    act(() => set({ dialog: { kind: "settings", section: "orphaned files" } }));
    render(<Dialogs />);
    expect(screen.getByText("Maintenance")).toBeInTheDocument();
    expect(await screen.findByText("/data/torrents")).toBeInTheDocument();
  });

  it("offers Forget all when the Keep list cannot be read", async () => {
    daemon = installFakeDaemon({
      orphans: {
        status: orphanStatus({ kept_error: "cannot be read: bad JSON" }),
      },
    });
    render(<OrphansSection />);
    expect(
      await screen.findByText("The remembered Keeps cannot be read"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Forget all" }));
    await waitFor(() => expect(calls("/forget")).toHaveLength(1));
  });

  it("scans once for Scan again, not on every later visit", async () => {
    daemon = installFakeDaemon({
      orphans: {
        status: orphanStatus(),
        scan: orphanScan({ entries: [] }),
      },
    });
    set({ session: defaultSession() });
    act(() =>
      set({
        dialog: { kind: "settings", section: "orphaned files", scan: true },
      }),
    );
    render(<Dialogs />);
    expect(await screen.findByText("Nothing new")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Speed" }));
    fireEvent.click(screen.getByRole("button", { name: "Orphaned files" }));
    expect(await screen.findByText("/data/torrents")).toBeInTheDocument();
    expect(calls("/scan")).toHaveLength(1);
  });
});

function review(
  opts: Parameters<typeof installFakeDaemon>[0] = {},
  scan = orphanScan(),
) {
  daemon = installFakeDaemon({
    orphans: { status: orphanStatus(), ...opts.orphans },
  });
  const onClose = vi.fn();
  const onRescan = vi.fn();
  render(<OrphanReview scan={scan} onClose={onClose} onRescan={onRescan} />);
  return { onClose, onRescan };
}

const item = (name: string) =>
  within(document.querySelector(".rv-list") as HTMLElement)
    .getByText(name)
    .closest("button") as HTMLElement;
const footer = () => document.querySelector(".rv-f") as HTMLElement;

describe("review", () => {
  it("decides by keyboard, jumping to the next undecided one", async () => {
    review();
    expect(screen.getByText("0 of 4 decided")).toBeInTheDocument();
    expect(item("nasa-apollo-11-mission-audio/")).toHaveClass("ocur");
    fireEvent.keyDown(document, { key: "d" });
    expect(item("nasa-apollo-11-mission-audio/")).toHaveClass("del");
    expect(item("bbb-extracted.mkv")).toHaveClass("ocur");
    fireEvent.keyDown(document, { key: "k" });
    expect(item("bbb-extracted.mkv")).toHaveClass("keep");
    await waitFor(() =>
      expect(calls("/keep", "POST")[0].body).toEqual({
        scan_id: "s1",
        id: "e2",
      }),
    );
    expect(screen.getByText("2 of 4 decided")).toBeInTheDocument();
    // Back up and take the Keep back: forgotten on the server too.
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(item("bbb-extracted.mkv")).toHaveClass("ocur");
    fireEvent.keyDown(document, { key: "u" });
    await waitFor(() =>
      expect(calls("/unkeep", "POST")[0].body).toEqual({
        scan_id: "s1",
        id: "e2",
      }),
    );
    // Sent in key-press order: the Keep before its Undo.
    const order = daemon.orphans.calls.map((c) => c.path);
    expect(order.indexOf("/keep")).toBeLessThan(order.indexOf("/unkeep"));
    expect(item("bbb-extracted.mkv")).not.toHaveClass("keep");
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(item("ubuntu-22.04.4-desktop-amd64.iso")).toHaveClass("ocur");
    // Modifier keys belong to someone else.
    fireEvent.keyDown(document, { key: "d", metaKey: true });
    expect(item("ubuntu-22.04.4-desktop-amd64.iso")).not.toHaveClass("del");
  });

  it("decides by clicking, filters by tab and shows the details", () => {
    review();
    fireEvent.click(item("ubuntu-22.04.4-desktop-amd64.iso"));
    const pane = document.querySelector(".rv-d") as HTMLElement;
    expect(
      within(pane).getByText(/No torrent owns this file/),
    ).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: /Keep/ }));
    fireEvent.click(item("openstreetmap-planet-2025-06"));
    expect(
      within(pane).getByText(/leftover files for a torrent it no longer has/),
    ).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: /Delete/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Undecided/ }));
    expect(document.querySelectorAll(".rv-it")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: /Keep/ }));
    expect(document.querySelectorAll(".rv-it")).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: /Delete/ }));
    expect(document.querySelectorAll(".rv-it")).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: /All/ }));
    expect(
      within(footer()).getByText(/undecided stay as they are/),
    ).toHaveTextContent("2 undecided");
  });

  it("deletes only what was marked, one request each, and reports every row", async () => {
    const { onRescan } = review({
      orphans: {
        onDelete: (id) =>
          id === "e2"
            ? { status: 409, error: "now belongs to Big Buck Bunny" }
            : id === "e3"
              ? { status: 500, error: "permission denied" }
              : undefined,
      },
    });
    const del = screen.getByRole("button", { name: /Delete …/ });
    expect(del).toBeDisabled();
    fireEvent.keyDown(document, { key: "d" }); // e1
    fireEvent.keyDown(document, { key: "d" }); // e2
    fireEvent.keyDown(document, { key: "d" }); // e3
    // e4 stays undecided
    fireEvent.click(screen.getByRole("button", { name: "Delete 3…" }));
    const confirm = screen.getByRole("dialog", { name: "Confirm delete" });
    expect(within(confirm).getAllByText(/\/data\/torrents\//)).toHaveLength(3);
    fireEvent.click(within(confirm).getByRole("button", { name: /^Delete 3/ }));
    await waitFor(() =>
      expect(
        within(footer()).getByText(/Deleted 1 of 3, 2 not deleted/),
      ).toBeInTheDocument(),
    );
    expect(calls("/delete").map((c) => c.body?.id)).toEqual(["e1", "e2", "e3"]);
    expect(
      screen.getByText("Kept: now belongs to Big Buck Bunny"),
    ).toBeInTheDocument();
    expect(screen.getByText("Failed: permission denied")).toBeInTheDocument();
    expect(item("nasa-apollo-11-mission-audio/")).toHaveClass("gone");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("nasa-apollo-11-mission-audio/")).toBeNull();
    expect(
      screen.getByText("3 found · 11.8 GB · 1,234 files looked at"),
    ).toBeInTheDocument();
    // The ones that did not go keep their Delete decision, for another try.
    expect(item("bbb-extracted.mkv")).toHaveClass("del");
    fireEvent.click(screen.getByRole("button", { name: "Delete 2…" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to review" }));
    expect(screen.queryByRole("dialog", { name: "Confirm delete" })).toBeNull();
    // Scan again from the done state.
    fireEvent.click(screen.getByRole("button", { name: "Delete 2…" }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete 2 ·/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Scan again" }));
    expect(onRescan).toHaveBeenCalled();
  });

  it("shows busy as a failure to retry, not as kept by the recheck", async () => {
    review({
      orphans: {
        onDelete: () => ({
          status: 423,
          error: "a scan or delete is already running",
        }),
      },
    });
    fireEvent.keyDown(document, { key: "d" });
    fireEvent.click(screen.getByRole("button", { name: "Delete 1…" }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete 1 ·/ }));
    expect(
      await screen.findByText("Failed: a scan or delete is already running"),
    ).toBeInTheDocument();
  });

  it("stops after the delete in flight", async () => {
    let release!: () => void;
    review({
      orphans: {
        onDelete: () =>
          new Promise<void>((r) => {
            release = r;
          }),
      },
    });
    fireEvent.keyDown(document, { key: "d" });
    fireEvent.keyDown(document, { key: "d" });
    fireEvent.click(screen.getByRole("button", { name: "Delete 2…" }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete 2 ·/ }));
    expect(await screen.findByText("Deleting 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Deleting…")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    act(() => release());
    await waitFor(() =>
      expect(within(footer()).getByText("Deleted 1 item")).toBeInTheDocument(),
    );
    expect(calls("/delete")).toHaveLength(1);
    expect(item("bbb-extracted.mkv")).toHaveClass("del");
  });

  it("closes back to its Settings entry", async () => {
    daemon = installFakeDaemon({ orphans: { status: orphanStatus() } });
    set({ session: defaultSession() });
    act(() => set({ dialog: { kind: "orphan-review", scan: orphanScan() } }));
    render(<Dialogs />);
    fireEvent.click(screen.getByTitle("Close"));
    expect(get().dialog).toEqual({
      kind: "settings",
      section: "orphaned files",
      scan: undefined,
    });
  });

  it("shows the scan's warnings and an empty tab", () => {
    review(
      {},
      orphanScan({
        warnings: [
          "2 torrent(s) keep their data in /mnt/x, which is not scanned",
        ],
      }),
    );
    expect(screen.getByText(/which is not scanned/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /Keep/ }));
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
  });

  it("toasts when a Keep cannot be saved", async () => {
    daemon = installFakeDaemon({ orphans: { status: orphanStatus() } });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(Response.json({ error: "disk full" }, { status: 500 })),
      );
    render(
      <OrphanReview scan={orphanScan()} onClose={vi.fn()} onRescan={vi.fn()} />,
    );
    fireEvent.keyDown(document, { key: "k" });
    await waitFor(() =>
      expect(get().toast).toBe("Could not remember the Keep: disk full"),
    );
    fireEvent.keyDown(document, { key: "ArrowUp" });
    fireEvent.keyDown(document, { key: "d" });
    await waitFor(() =>
      expect(get().toast).toBe("Could not forget the Keep: disk full"),
    );
    spy.mockRestore();
  });
});

const now = Math.floor(Date.now() / 1000);
const o = (x: Partial<Orphan>): Orphan => ({
  id: "e1",
  group: "/data",
  path: "/data/a/b",
  kind: "file",
  size: 1,
  files: 1,
  mtime: now - 86400,
  ...x,
});
const text = (x: Orphan) => {
  const { container } = render(<div>{why(x)}</div>);
  const t = container.textContent ?? "";
  container.remove();
  return t;
};

describe("helpers", () => {
  it("names entries", () => {
    expect(label(o({ kind: "dir", path: "/data/x" }))).toBe("x/");
    expect(
      label(o({ kind: "state", hash: "abcdef0123456789", name: "" })),
    ).toBe("abcdef…6789");
    expect(parentRel(o({}))).toBe("a/");
    expect(parentRel(o({ path: "/data/b" }))).toBe("");
  });

  it("summarises contents", () => {
    expect(contents(o({ kind: "symlink" }))).toBe("a symbolic link");
    expect(contents(o({ kind: "state", files: 1 }))).toBe(
      "1 Transmission file",
    );
    expect(contents(o({ types: { video: 1, subtitle: 3 } }))).toBe(
      "3 subtitle · 1 video",
    );
    expect(contents(o({ types: {} }))).toBe("—");
  });

  it("explains why each kind is here", () => {
    expect(text(o({ flags: ["match"], match: "/mnt/x" }))).toMatch(
      /exact name.*\/mnt\/x.*keep it/,
    );
    expect(text(o({ flags: ["torrent"], name: "arch.iso" }))).toMatch(
      /not loaded.*It is for arch.iso/,
    );
    expect(text(o({ flags: ["partial"] }))).toMatch(/unfinished download/);
    expect(text(o({ kind: "symlink" }))).toMatch(/removes the link only/);
    expect(text(o({ kind: "dir", flags: ["hardlink"] }))).toMatch(
      /No torrent owns this folder.*frees no space/,
    );
    expect(text(o({ mtime: now - 60 }))).toMatch(
      /Changed 1m ago.*Keep is the safer call/,
    );
  });
});

describe("api", () => {
  it("treats a non-JSON answer as not set up, and reports other failures", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockResolvedValueOnce(
      new Response("<html>", { headers: { "Content-Type": "text/html" } }),
    );
    expect(await fetchStatus()).toBeNull();
    spy.mockResolvedValueOnce(
      Response.json({ error: "cannot read" }, { status: 500 }),
    );
    await expect(fetchStatus()).rejects.toThrow("cannot read");
    spy.mockResolvedValueOnce(new Response("", { status: 502 }));
    await expect(scanOrphans(() => {})).rejects.toThrow("HTTP 502");
    spy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ progress: { looked: 1, path: "/" } }) + "\n",
      ),
    );
    await expect(scanOrphans(() => {})).rejects.toThrow("without a result");
    spy.mockRestore();
    expect(new KeptByRecheck("x")).toBeInstanceOf(Error);
  });
});
