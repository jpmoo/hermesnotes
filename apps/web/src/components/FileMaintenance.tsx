import { HardDrive } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface Health {
  orphans: number;
  wasted: number;
  /** Attachments — one per file on a note. */
  files: number;
  /** Distinct blobs behind them. */
  blobs: number;
  /** What the attachments add up to, counting shared files once each time. */
  named: number;
  /** What is actually on disk. */
  stored: number;
}

/**
 * Bytes nothing points at.
 *
 * Files are stored once under their own digest and attachments point at them,
 * so the same PDF on four notes is four rows and one file. Deleting the last
 * attachment for a file collects its bytes in the same request — but that is
 * one code path holding a promise about disk, and those fail quietly. A block
 * deleted takes its attachments with it by cascade, which never runs that code
 * at all.
 *
 * So this asks, and offers to sweep. Deliberately a button, like the tag
 * sweep beside it: "nothing points at this" is a statement about a moment.
 */
export function FileMaintenance() {
  const [health, setHealth] = useState<Health | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = () =>
    void api
      .get<Health>("/attachments/orphans")
      .then(setHealth)
      .catch(() => setHealth(null));
  useEffect(load, []);

  const sweep = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const out = await api.post<{ deleted: number; freed: number }>("/attachments/orphans/sweep");
      setDone(
        out.deleted
          ? `Removed ${out.deleted} orphaned file${out.deleted === 1 ? "" : "s"}, freeing ${human(out.freed)}.`
          : "Nothing to remove.",
      );
      load();
    } finally {
      setBusy(false);
    }
  };

  if (!health) return null;

  // What sharing saved: the difference between what the attachments add up to
  // and what is actually stored. Zero is the honest answer when nothing is
  // shared, so it is only mentioned when there is something to mention.
  const saved = Math.max(0, health.named - health.stored);

  return (
    <div className="card">
      <h2 className="chrome" style={{ margin: "0 0 4px", fontSize: 15 }}>
        <HardDrive size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Files
      </h2>
      <p className="hint" style={{ marginBottom: 10 }}>
        {health.files} attachment{health.files === 1 ? "" : "s"} across {health.blobs} distinct
        file{health.blobs === 1 ? "" : "s"}, {human(health.stored)} on disk
        {saved > 0 ? ` — sharing identical files saves ${human(saved)}` : ""}.
      </p>

      <p className="hint" style={{ marginBottom: 12 }}>
        {health.orphans === 0 ? (
          "No orphaned files: every stored file has something pointing at it."
        ) : (
          <>
            <strong>
              {health.orphans} orphaned file{health.orphans === 1 ? "" : "s"}
            </strong>{" "}
            taking {human(health.wasted)} — stored, but nothing points at them any more.
          </>
        )}
      </p>

      {done && (
        <p className="hint" style={{ marginBottom: 12 }}>
          {done}
        </p>
      )}

      <button
        className="primary"
        disabled={busy || health.orphans === 0}
        onClick={() => setConfirming(true)}
      >
        {busy ? "Removing…" : "Remove orphaned files"}
      </button>

      <ConfirmDialog
        open={confirming}
        title="Remove orphaned files?"
        message={`${health.orphans} stored file${health.orphans === 1 ? "" : "s"} that nothing points at will be permanently deleted, freeing ${human(health.wasted)}. Files still attached to a note are not touched. This can't be undone.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => void sweep()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
