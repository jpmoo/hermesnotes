import { useEffect, useRef, useState } from "react";
import { api, type Block, type BlockType } from "../api.ts";
import { TextBlockEditor } from "./TextBlockEditor.tsx";
import { TypedBlockCard } from "./TypedBlockCard.tsx";
import { focusFirstFieldSoon } from "../lib/focus-first.ts";

/** Create a new block of `type` in the collection and edit it in a modal. */
export function NewItemModal({
  collectionId,
  type,
  onClose,
}: {
  collectionId: string;
  type: BlockType;
  onClose: () => void;
}) {
  const [block, setBlock] = useState<Block | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // The block arrives a moment after the modal does; put the caret in it then.
  useEffect(() => {
    if (block) focusFirstFieldSoon(() => cardRef.current);
  }, [block]);

  useEffect(() => {
    void api
      .post<{ blockId: string }>(`/collections/${collectionId}/members`, {
        create: type.isText ? {} : { blockTypeId: type.id },
      })
      .then((r) => api.get<Block>(`/blocks/${r.blockId}`))
      .then(setBlock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = () => {
    if (block) void api.get<Block>(`/blocks/${block.id}`).then(setBlock);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card new-item" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title" style={{ textTransform: "capitalize" }}>
          New {type.name}
        </h2>
        <div ref={cardRef}>
          {!block ? (
            <div className="hint">Creating…</div>
          ) : type.isText ? (
            <TextBlockEditor block={block} onConflict={reload} onDeleted={onClose} />
          ) : (
            <TypedBlockCard block={block} type={type} onConflict={reload} onDeleted={onClose} />
          )}
        </div>
        <div className="modal-actions" style={{ marginTop: 8 }}>
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
