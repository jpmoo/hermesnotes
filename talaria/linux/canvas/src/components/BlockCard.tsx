/*
 * A placed block, as Talaria draws one.
 *
 * This is the one part the brief said would need real work, and its reasoning
 * is unchanged: "Hermes renders a placed block as a `BlockCard` — a live editor
 * against the Hermes API. Talaria's block nodes are a title, a type icon and a
 * completion box, read from the local mirror."
 *
 * The mirror is why. Hermes' card fetches the block, edits its fields and saves
 * them; Talaria's canvas is a thing you look at while offline, and every fact
 * on this card came out of `POST /linked` with the rest of the canvas. Ticking
 * the box goes through the daemon's own write queue, so it survives being done
 * on a train.
 */
import { useState } from "react";
import { ask, type Block, type BlockType } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";

export function BlockCard({
  block,
  type,
  onDeleted: _onDeleted,
  onConflict: _onConflict,
  compact: _compact,
}: {
  block: Block;
  type?: BlockType;
  onDeleted?: () => void;
  onConflict?: () => void;
  compact?: boolean;
}) {
  const props = block.properties as Record<string, unknown>;
  const missing = props.talaria_missing === true;
  const url = typeof props.talaria_url === "string" ? props.talaria_url : null;
  const [status, setStatus] = useState<string | null>(
    typeof props.talaria_status === "string" ? props.talaria_status : null,
  );
  const [busy, setBusy] = useState(false);

  if (missing) {
    // Named rather than blank. The daemon draws the distinction between a block
    // it has never heard of and one that is archived, and a node that renders
    // as an empty card throws that away.
    return <div className="tal-node tal-missing">Not in the mirror</div>;
  }

  /*
   * Completion, read through the profile and never through a type's name.
   *
   * The daemon has already resolved which property holds status for this
   * block's type and handed over its value; `null` means this is not the kind
   * of thing that finishes. A note is not unfinished — it simply does not
   * complete, which is the repo's first invariant restated as a checkbox that
   * is absent rather than empty.
   */
  const completable = status !== null;
  const done = status === "done";

  return (
    <div
      className={"tal-node" + (done ? " tal-done" : "")}
      /*
       * Double-click opens the block in Hermes Notes.
       *
       * On the whole card rather than on its title: the node *is* the block as
       * far as this canvas is concerned, and a target the size of one line of
       * text is a target you miss. A single click still selects and drags —
       * this is the second click, which on a node that cannot be edited is free
       * to mean something else.
       */
      title={url ? "Double-click to open in Hermes Notes" : undefined}
      onDoubleClick={() => {
        if (url) window.location.href = url;
      }}
    >
      <div className="tal-head">
        {/*
          * The box, or the icon — never both.
          *
          * For anything that can be finished, the box *is* the type indicator:
          * it says what kind of thing this is by the fact that it can be ticked,
          * and it says where the thing has got to, which an icon cannot. Putting
          * a circle-with-a-check beside a checkbox is the same fact drawn twice.
          *
          * And it is a control rather than a picture. "A checkbox that shows the
          * state and cannot change it is a worse checkbox than none" — the Mac's
          * words, and the one interaction a linked node keeps: completing
          * something is not editing it. Everything else about the block belongs
          * to Hermes Notes.
          */}
        {completable ? (
          <input
            type="checkbox"
            checked={done}
            disabled={busy}
            title={done ? "Completed — click to undo" : "Mark complete"}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={async () => {
              setBusy(true);
              try {
                await ask("POST", "/write", { kind: "complete", blockId: block.id });
                setStatus(done ? "not done" : "done");
              } catch {
                // The daemon queues writes it cannot send, so a failure here is
                // a failure to *queue* — rare, and not worth a dialog over a
                // checkbox.
              } finally {
                setBusy(false);
              }
            }}
          />
        ) : (
          /* `iconKey`, which is what it takes. Passing the type object left it
           * undefined, so every linked node wore the fallback file glyph and
           * looked like the same kind of thing as every other. */
          type && <BlockIcon iconKey={type.iconKey} color={type.iconColor} size={14} />
        )}
        <span className="tal-title">
          {block.content || "Untitled"}
        </span>
      </div>
    </div>
  );
}
