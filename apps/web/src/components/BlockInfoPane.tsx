import { CalendarDays, Copy, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, type Block, type BlockInfo, type BlockType, type ConnRef } from "../api.ts";
import { fmtDateTime } from "../lib/format.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { emitBlockChange, useBlockChanged, useBlockOrigin, useBlockSync } from "../lib/block-events.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { LongTextField } from "./LongTextField.tsx";
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
            className={`info-conn-item${it.archived ? " archived" : ""}`}
            title={it.archived ? `${it.label} — archived` : it.label}
            onClick={() => onSelect(it.id)}
          >
            <BlockIcon iconKey={it.iconKey} color={it.iconColor} size={14} />
            <span className="info-conn-text">{it.label}</span>
            {it.archived && <span className="ref-badge">archived</span>}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * A collection's description — the one long-text field that saves to the
 * collection (PATCH /collections/:id), not to a block-type field. Self-contained:
 * mounts with the loaded value, debounces edits, and flushes on unmount so a save
 * in flight isn't lost when the panel closes or you pick another block. Mount it
 * keyed by collection id so each collection gets a fresh initial value.
 */
function CollectionDescription({ collectionId, initial }: { collectionId: string; initial: string }) {
  const origin = useBlockOrigin();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef<string | null>(null);
  const focusedRef = useRef(false);
  // The editor owns its content, so a remote change remounts it (keyed by nonce)
  // — but not while you're editing here (held until blur / the save settles).
  const [ext, setExt] = useState({ value: initial, nonce: 0 });
  const dirty = () => pending.current != null;
  const releaseSync = useBlockSync(
    collectionId,
    origin,
    (b) => setExt((e) => ({ value: String((b.properties as Record<string, unknown>)?.description ?? ""), nonce: e.nonce + 1 })),
    () => focusedRef.current || dirty(),
  );
  const commit = (v: string) => {
    void api.patch(`/collections/${collectionId}`, { description: v }).then(() => {
      emitBlockChange(collectionId, origin); // sync other surfaces (and other windows via SSE)
      if (!focusedRef.current && !dirty()) releaseSync();
    });
  };
  const save = (v: string) => {
    pending.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      timer.current = undefined;
      commit(v);
    }, 700);
  };
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        if (pending.current != null) commit(pending.current);
      }
    },
    // commit closes over stable refs/id; only re-arm when the collection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collectionId],
  );
  return (
    <LongTextField
      key={ext.nonce}
      value={ext.value}
      onChange={save}
      placeholder="Describe this collection…"
      blockId={collectionId}
      onFocusChange={(f) => {
        focusedRef.current = f;
        if (!f && !dirty()) releaseSync();
      }}
    />
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
  const { infoTick } = usePanels();
  const { isFavorite, toggleFavorite } = usePreferences();

  // Blank out only when the shown block changes; an infoTick bump (the block
  // was edited elsewhere, e.g. matrix region actions) refetches in place.
  useEffect(() => {
    setInfo(null);
    setBlock(null);
  }, [blockId]);

  // Collection description lives here (not on the page) and is embedded with
  // the title, so semantic search finds the collection by purpose.
  const isCollection = Boolean(block?.collectionKind);

  useEffect(() => {
    void api.get<BlockInfo>(`/blocks/${blockId}/info`).then(setInfo).catch(() => setInfo(null));
  }, [blockId, infoTick]);
  // Any change event for this block (own edits included — mentions and canvas
  // edges alter connections) refreshes the info section in place.
  useBlockChanged(blockId, () =>
    void api.get<BlockInfo>(`/blocks/${blockId}/info`).then(setInfo).catch(() => {}),
  );

  const loadBlock = () =>
    api
      .get<Block>(`/blocks/${blockId}`)
      .then(setBlock)
      .catch(() => setBlock(null));
  useEffect(() => {
    void loadBlock();
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, infoTick]);

  if (!info) return <div className="hint">Loading…</div>;

  // Edit-in-panel — except for collections (they have their own page), daily
  // notes (the scratchpad is on screen), and the block's own full page (two
  // live editors on one block would fight over versions).
  const editable =
    block != null && !block.collectionKind && !titleOverride && pathname !== `/block/${blockId}`;
  const editorType = block?.blockTypeId ? types.find((t) => t.id === block.blockTypeId) : undefined;

  const canvasConns = (info.canvasConnections ?? []).map((c) => ({
    ...c,
    label: `${c.label}${c.edgeLabel ? ` — “${c.edgeLabel}”` : ""} · ${c.canvasLabel}`,
  }));
  const noConnections =
    info.inCollections.length === 0 &&
    info.linksTo.length === 0 &&
    info.linkedFrom.length === 0 &&
    canvasConns.length === 0 &&
    (editable || info.tags.length === 0);

  const fav = isFavorite(blockId);
  return (
    <div className="info-pane">
      <button
        className={`icon-btn fav-star${fav ? " on" : ""}`}
        title={fav ? "Remove from favorites" : "Add to favorites"}
        onClick={() => toggleFavorite(blockId)}
      >
        <Star size={15} fill={fav ? "currentColor" : "none"} />
      </button>
      {editable && block ? (
        <div className="panel-editor">
          {editorType && !editorType.isText ? (
            // Not compact: compact swaps the attachments field for a count chip
            // (invisible at 0 files) — the panel is an editing surface and
            // needs the real controls.
            <TypedBlockCard
              key={`${block.id}:${block.version}`}
              block={block}
              type={editorType}
              onConflict={() => void loadBlock()}
              onDeleted={() => onDeleted?.()}
              hideBanner
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
              hideBanner
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
      {isCollection && block && (
        <div className="collection-desc">
          <div className="panel-h">Description</div>
          <CollectionDescription
            key={`desc-${blockId}`}
            collectionId={blockId}
            initial={String(block.properties?.description ?? "")}
          />
        </div>
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
            <ConnGroup label="Connected on canvas" items={canvasConns} onSelect={onSelect} />
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
