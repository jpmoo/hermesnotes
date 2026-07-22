import { CalendarDays, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, type Block, type BlockInfo, type BlockType, type ConnRef } from "../api.ts";
import { fmtDateTime } from "../lib/format.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { TextBlockEditor } from "./TextBlockEditor.tsx";
import { TypedBlockCard } from "./TypedBlockCard.tsx";

const fmtDayShort = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

/** Every connection drills through the info-box history (blocks and collections). */
function ConnGroup({
  label,
  items,
  onSelect,
}: {
  label: string;
  items: ConnRef[];
  onSelect: (id: string) => void;
}) {
  const nav = useNavigate();
  if (items.length === 0) return null;
  return (
    <div className="info-conn">
      <div className="info-conn-label">{label}</div>
      {items.map((it) =>
        it.today ? (
          <button
            key={it.id}
            className="info-conn-item"
            title={`Daily note · ${fmtDayShort(it.today)}`}
            onClick={() => nav(`/today/${it.today}`)}
          >
            <CalendarDays size={14} />
            <span className="info-conn-text">Daily Note · {fmtDayShort(it.today)}</span>
          </button>
        ) : (
          <button
            key={it.id}
            className="info-conn-item"
            title={it.label}
            onClick={() => onSelect(it.id)}
          >
            <BlockIcon iconKey={it.iconKey} color={it.iconColor} size={14} />
            <span className="info-conn-text">{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

/** Right-panel info pane: an editable card for the selected block + its info. */
export function BlockInfoPane({
  blockId,
  onSelect,
  onSelectCollection,
  onDeleted,
  titleOverride,
}: {
  blockId: string;
  onSelect: (id: string) => void;
  onSelectCollection: (id: string) => void;
  onDeleted?: () => void;
  titleOverride?: string;
}) {
  const [info, setInfo] = useState<BlockInfo | null>(null);
  const [block, setBlock] = useState<Block | null>(null);
  const [types, setTypes] = useState<BlockType[]>([]);
  const { pathname } = useLocation();

  useEffect(() => {
    setInfo(null);
    void api.get<BlockInfo>(`/blocks/${blockId}/info`).then(setInfo).catch(() => setInfo(null));
  }, [blockId]);

  const loadBlock = () =>
    api
      .get<Block>(`/blocks/${blockId}`)
      .then(setBlock)
      .catch(() => setBlock(null));
  useEffect(() => {
    setBlock(null);
    void loadBlock();
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);

  if (!info) return <div className="hint">Loading…</div>;

  // Edit-in-panel — except for collections (they have their own page), daily
  // notes (the scratchpad is on screen), and the block's own full page (two
  // live editors on one block would fight over versions).
  const editable =
    block != null && !block.collectionKind && !titleOverride && pathname !== `/block/${blockId}`;
  const editorType = block?.blockTypeId ? types.find((t) => t.id === block.blockTypeId) : undefined;

  const noConnections =
    info.inCollections.length === 0 &&
    info.linksTo.length === 0 &&
    info.linkedFrom.length === 0 &&
    (editable || info.tags.length === 0);

  return (
    <div className="info-pane">
      {editable && block ? (
        <div className="panel-editor">
          {editorType && !editorType.isText ? (
            <TypedBlockCard
              key={`${block.id}:${block.version}`}
              block={block}
              type={editorType}
              compact
              onConflict={() => void loadBlock()}
              onDeleted={() => onDeleted?.()}
            />
          ) : (
            // Not compact: text-note compact mode is a read-only preview, and
            // the whole point here is editing.
            <TextBlockEditor
              key={`${block.id}:${block.version}`}
              block={block}
              type={editorType}
              onConflict={() => void loadBlock()}
              onDeleted={() => onDeleted?.()}
            />
          )}
        </div>
      ) : (
        (titleOverride || info.title) && (
          <div className="info-title">
            {titleOverride ? (
              <CalendarDays size={18} />
            ) : (
              <BlockIcon iconKey={info.iconKey} color={info.iconColor} size={18} />
            )}
            <span className="info-title-text">{titleOverride ?? info.title}</span>
          </div>
        )
      )}
      <dl className="info-grid">
        {!editable && (
          <>
            <dt>Created</dt>
            <dd>{fmtDateTime(info.createdAt)}</dd>
            <dt>Edited</dt>
            <dd>{fmtDateTime(info.updatedAt)}</dd>
          </>
        )}
        {info.attachments > 0 && (
          <>
            <dt>Files</dt>
            <dd>{info.attachments}</dd>
          </>
        )}
        <dt>ID</dt>
        <dd className="info-id">
          <code>{info.id}</code>
          <button
            className="icon-btn"
            title="Copy id"
            onClick={() => void navigator.clipboard?.writeText(info.id)}
          >
            <Copy size={12} />
          </button>
        </dd>
      </dl>

      <div className="info-conns">
        <div className="panel-h">Connections</div>
        {noConnections ? (
          <div className="hint">No connections.</div>
        ) : (
          <>
            <ConnGroup
              label="In collection"
              items={info.inCollections}
              onSelect={onSelectCollection}
            />
            <ConnGroup label="Links to" items={info.linksTo} onSelect={onSelect} />
            <ConnGroup label="Linked from" items={info.linkedFrom} onSelect={onSelect} />
            {!editable && info.tags.length > 0 && (
              <div className="info-conn">
                <div className="info-conn-label">Tagged</div>
                <div className="info-tags">
                  {info.tags.map((t) => (
                    <span key={t} className="tag-chip">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
