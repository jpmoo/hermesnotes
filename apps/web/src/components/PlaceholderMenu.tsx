import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { emitBlockChange } from "../lib/block-events.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { useMenuPosition } from "../lib/menu-position.ts";

/**
 * "What is this, then?" — the menu a placeholder opens when you finally decide.
 *
 * Same list as the rail's New button, because it's the same question. Choosing
 * a type creates the block and points every mention of that placeholder at it,
 * so the one written in Monday's note and the one in Thursday's turn out to
 * have been the same thing all along.
 */
export function PlaceholderMenu({
  label,
  at,
  onClose,
  onCreated,
}: {
  label: string;
  at: { x: number; y: number };
  onClose: () => void;
  onCreated: (block: Block) => void;
}) {
  const [types, setTypes] = useState<BlockType[]>([]);
  const [busy, setBusy] = useState(false);
  const [ref, style] = useMenuPosition(at.x, at.y);

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
  }, []);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".ph-menu")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const create = async (t: BlockType) => {
    if (busy) return;
    setBusy(true);
    try {
      const { block, rewritten } = await api.post<{ block: Block; rewritten: string[] }>(
        "/blocks/placeholder",
        { label, blockTypeId: t.id },
      );
      // Every note that named it now points at the real thing; an editor still
      // holding the old text would write the placeholder back on its next save.
      for (const id of rewritten) emitBlockChange(id, "placeholder");
      onCreated(block);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const ordered = [...types].sort((a, b) =>
    a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1,
  );

  return createPortal(
    <div ref={ref} className="menu ph-menu" style={style}>
      <div className="hint" style={{ padding: "6px 10px" }}>
        {/* Named, not typed: the server strips the underscores a spaceless
            trigger obliged you to write, so offer the name it will get. */}
        Create “{label.replace(/_/g, " ")}” as…
      </div>
      {ordered.map((t) => (
        <button
          key={t.id}
          className="menu-item type-item"
          disabled={busy}
          onClick={() => void create(t)}
        >
          <BlockIcon iconKey={t.isText ? "type" : t.iconKey} color={t.isText ? null : t.iconColor} size={16} />
          <span style={{ textTransform: "capitalize" }}>{t.name}</span>
        </button>
      ))}
      {ordered.length === 0 && <div className="hint">No types yet.</div>}
    </div>,
    document.body,
  );
}
