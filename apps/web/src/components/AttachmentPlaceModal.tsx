import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { api, ApiError, type Attachment, type Block, type BlockSearchResult, type BlockType } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/** Whether a type has anywhere to put a file. */
export function holdsFiles(type: BlockType): boolean {
  return (type.propertySchema?.fields ?? []).some((f) => f.type === "attachments");
}

/**
 * Where a file should go instead.
 *
 * Search, or make somewhere new. **Only blocks whose type has an attachment
 * field** are offered: a file placed on a type with nowhere to show one is a
 * file nobody will find again, and offering the choice at all would be the
 * interface promising something the schema cannot keep.
 *
 * The search is filtered client-side rather than by the server, which is a
 * deliberate limit worth stating: `/blocks/search` has no notion of "types with
 * a field of this kind", so what arrives is a page of results and what is shown
 * is the subset that can hold a file. A search whose every hit is the wrong kind
 * looks empty when it is merely filtered — so it says so.
 */
export function AttachmentPlaceModal({
  attachment,
  mode,
  types,
  onClose,
  onDone,
}: {
  attachment: Attachment;
  mode: "move" | "copy";
  types: BlockType[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<BlockSearchResult[]>([]);
  const [filtered, setFiltered] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { openBlock } = usePanels();

  const holders = useMemo(() => types.filter(holdsFiles), [types]);
  const holderIds = useMemo(() => new Set(holders.map((t) => t.id)), [holders]);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  /**
   * What Enter takes. Back to the first whenever the results change, so typing
   * and pressing Enter takes the best match — the rule every other picker here
   * follows.
   *
   * Index 0 is "make a new one" whenever there is a name to give it, so an
   * empty search does not offer to create something called nothing.
   */
  const canCreate = q.trim().length > 0 && holders.length > 0;
  const rows = canCreate ? [null, ...results] : results;
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [q, results.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .get<BlockSearchResult[]>(`/blocks/search?q=${encodeURIComponent(q)}`)
        .then((all) => {
          const kept = all.filter((r) => r.blockTypeId && holderIds.has(r.blockTypeId));
          setFiltered(all.length - kept.length);
          setResults(kept);
        })
        .catch(() => {
          setResults([]);
          setFiltered(0);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [q, holderIds]);

  /**
   * Chosen, but not yet done.
   *
   * A move takes a file off the note somebody is looking at, and a list where
   * one tap in the wrong row rearranges their library is a list people use
   * carefully and slowly. The confirm step costs a tap and buys the ability to
   * scan the results without holding your breath.
   */
  const [chosen, setChosen] = useState<{ id: string; title: string } | null>(null);
  const [went, setWent] = useState<string | null>(null);

  const place = async (blockId: string, title: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/attachments/${attachment.id}/place`, { blockId, mode });
      onDone();
      // Said, rather than assumed from the modal closing. A move that silently
      // succeeds looks exactly like a move that silently did nothing, and the
      // file is no longer on the note you are looking at to prove otherwise.
      setWent(title);
      setChosen(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `could not ${mode} that file`);
      setBusy(false);
    }
  };

  /**
   * Somewhere new, with the file already on it.
   *
   * Made and then placed, in that order, because an attachment is keyed by the
   * block it belongs to — there is no attaching a file to a block that does not
   * exist yet. The new block is opened afterwards so the field is not merely
   * populated but visibly so.
   */
  const makeAndPlace = async (type: BlockType) => {
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<Block>("/blocks", {
        blockTypeId: type.id,
        properties: { title: q.trim() },
      });
      await api.post(`/attachments/${attachment.id}/place`, { blockId: made.id, mode });
      onDone();
      // A new note is opened rather than announced: landing on it is the
      // stronger confirmation, and it is the thing somebody wants next.
      onClose();
      openBlock(made.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not make that note");
      setBusy(false);
    }
  };

  const take = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    if (row === null) {
      // One kind that can hold a file: no question worth asking. Several, and
      // the choice is the row below.
      if (holders.length === 1) void makeAndPlace(holders[0]!);
      return;
    }
    setChosen({ id: row.id, title: row.label });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card finder" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">
          {mode === "move" ? "Move" : "Copy"} {attachment.filename}
        </h2>
        {went ? (
          <p className="hint" style={{ marginBottom: 10 }}>
            {mode === "move" ? "Moved" : "Copied"} to <strong>{went}</strong>.{" "}
            {mode === "copy"
              ? "The file is on both notes and stored once."
              : "It is no longer on the note you came from."}
          </p>
        ) : null}

        <input
          type="text"
          placeholder="Search notes that can hold a file…"
          autoComplete="off"
          value={q}
          autoFocus
          disabled={busy}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              setActive((i) => (i + 1) % Math.max(rows.length, 1));
              e.preventDefault();
            } else if (e.key === "ArrowUp") {
              setActive((i) => (i - 1 + rows.length) % Math.max(rows.length, 1));
              e.preventDefault();
            } else if (e.key === "Enter") {
              take(active);
              e.preventDefault();
            }
          }}
        />

        {error && <p className="hint" style={{ color: "var(--danger)" }}>{error}</p>}

        <ul className="finder-results">
          {canCreate && (
            <li
              className={`finder-row${active === 0 ? " active" : ""}`}
              onMouseEnter={() => setActive(0)}
            >
              <span className="finder-label">
                Create <strong>{q.trim()}</strong>
              </span>
              <span className="finder-new-types">
                {holders.map((t) => (
                  <button
                    key={t.id}
                    className="pill"
                    disabled={busy}
                    onClick={() => void makeAndPlace(t)}
                  >
                    <BlockIcon iconKey={t.isText ? "type" : t.iconKey} color={t.iconColor} size={12} />{" "}
                    {t.name}
                  </button>
                ))}
              </span>
            </li>
          )}
          {results.map((r, i) => {
            const at = canCreate ? i + 1 : i;
            return (
              <li
                key={r.id}
                className={`finder-row${active === at ? " active" : ""}`}
                onMouseEnter={() => setActive(at)}
                onClick={() => setChosen({ id: r.id, title: r.label })}
              >
                <BlockIcon
                  iconKey={(() => {
                    const t = r.blockTypeId ? typeById.get(r.blockTypeId) : undefined;
                    return t ? (t.isText ? "type" : t.iconKey) : "type";
                  })()}
                  color={r.blockTypeId ? typeById.get(r.blockTypeId)?.iconColor : null}
                  size={14}
                />
                <span className="finder-label">{r.label || "Untitled"}</span>
              </li>
            );
          })}
        </ul>

        {holders.length === 0 ? (
          <p className="hint">No type in your library has an attachment field, so there is nowhere to put this.</p>
        ) : results.length === 0 && filtered > 0 ? (
          // An empty list and a filtered-away list look identical, and only one
          // of them means "nothing matched".
          <p className="hint">
            {filtered} match{filtered === 1 ? "" : "es"} hidden — their types have no attachment field.
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={chosen !== null}
        title={mode === "move" ? "Move this file?" : "Copy this file?"}
        message={
          chosen
            ? mode === "move"
              ? `“${attachment.filename}” moves to “${chosen.title}” and comes off the note you came from. The file itself is not duplicated or deleted.`
              : `“${attachment.filename}” is added to “${chosen.title}”. Both notes point at the same stored file, so this costs no extra space.`
            : ""
        }
        confirmLabel={mode === "move" ? "Move" : "Copy"}
        danger={false}
        onCancel={() => setChosen(null)}
        onConfirm={() => chosen && void place(chosen.id, chosen.title)}
      />
    </div>
  );
}
