import { Tags } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/**
 * Tags nothing wears.
 *
 * A tag row outlives the blocks that carried it: `block_tags` cascades when a
 * block is deleted, the tag itself does not. Normally that leaves one or two
 * behind and nobody notices. Import a vault and delete it again and it leaves
 * thousands, in every tag picker, forever.
 *
 * Deliberately a button. `POST /tags` makes a tag before anything wears one, so
 * an unworn tag is not always a leftover — sweeping automatically would delete
 * the tag somebody made thirty seconds ago for the note they are about to
 * write.
 *
 * Worth saying plainly: archiving is not deleting. A tag on an archived note
 * still has a block wearing it and is not swept, which is right — unarchive the
 * note and the tag is still there.
 */
export function TagMaintenance() {
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = () =>
    void api
      .get<{ name: string; count: number }[]>("/tags")
      .then(setTags)
      .catch(() => {});
  useEffect(load, []);

  const unused = tags.filter((t) => !t.count);

  const sweep = async () => {
    setBusy(true);
    setConfirming(false);
    try {
      const res = await api.post<{ deleted: number }>("/tags/sweep");
      setDone(`Removed ${res.deleted} unused tag${res.deleted === 1 ? "" : "s"}.`);
      load();
    } catch (e) {
      setDone(e instanceof Error ? e.message : "couldn't sweep tags");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="panel-h" style={{ marginTop: 0 }}>Tags</div>
      <p className="hint" style={{ marginTop: 0 }}>
        {tags.length} tag{tags.length === 1 ? "" : "s"}
        {unused.length > 0 && <> — {unused.length} worn by nothing</>}.
        A tag outlives the blocks that carried it, so deleting notes leaves its tags behind. Tags on
        archived notes are still in use and aren’t touched.
      </p>
      {unused.length > 0 && (
        <p className="hint">
          {unused.slice(0, 12).map((t) => `#${t.name}`).join(", ")}
          {unused.length > 12 ? `, and ${unused.length - 12} more` : ""}
        </p>
      )}
      <div className="row" style={{ marginTop: 10, alignItems: "center", gap: 12 }}>
        <button className="ghost" onClick={() => setConfirming(true)} disabled={busy || !unused.length}>
          <Tags size={15} /> {busy ? "Removing…" : `Remove ${unused.length || "unused"} tag${unused.length === 1 ? "" : "s"}`}
        </button>
        {done && <span className="hint">{done}</span>}
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Remove ${unused.length} unused tag${unused.length === 1 ? "" : "s"}?`}
        // No typed confirmation: an unworn tag is a name and nothing else, and
        // typing `#name` anywhere brings it straight back. Making somebody spell
        // out a word for that would teach them to spell it out for the ones that
        // matter.
        message="Nothing is wearing these, so nothing loses a tag. Typing the name again recreates it."
        confirmLabel="Remove"
        danger={false}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void sweep()}
      />
    </div>
  );
}
