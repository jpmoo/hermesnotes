import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Block, type BlockType, type Collection, type Member } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { useBlockView, type BlockViewState } from "../lib/useBlockView.tsx";
import { BlockCard } from "./BlockCard.tsx";
import { ListItem, type ListFormat } from "./ListItem.tsx";
import { MatrixView } from "./MatrixView.tsx";
import { TableView } from "./TableView.tsx";

type SetMembers = (fn: (members: Member[]) => Member[]) => void;

/** An embedded list, rendered with its own format and the full view toolbar. */
function ListBody({
  collection,
  members,
  setMembers,
  types,
  reload,
  host,
}: {
  collection: Collection;
  members: Member[];
  setMembers: SetMembers;
  types: BlockType[];
  reload: () => void;
  host?: string;
}) {
  const cid = collection.id;
  const props = collection.properties as Record<string, unknown>;
  const format = (props.list_format as ListFormat) ?? "bullet";
  const syncStatus = props.sync_checkbox_with_status !== false;
  const isDynamic =
    props.membership_mode === "smart" && ((props.smart_mode as string) ?? "dynamic") === "dynamic";
  const typeById = new Map(types.map((t) => [t.id, t]));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const moveMember = (activeId: string, overId: string) => {
    if (isDynamic) return;
    const oldI = members.findIndex((m) => m.id === activeId);
    const newI = members.findIndex((m) => m.id === overId);
    if (oldI < 0 || newI < 0) return;
    const arr = arrayMove(members, oldI, newI);
    setMembers(() => arr);
    const afterId = arr[newI - 1]?.id ?? null;
    const beforeId = arr[newI + 1]?.id ?? null;
    void api.patch(`/collections/${cid}/members/${activeId}`, { afterId, beforeId });
  };

  // Embeds inherit the original list's saved view state, then fork on first
  // change — stored per host+collection, never written back to the original.
  const forkKey = host ? `hn.vs.${host}.${cid}` : null;
  const initialVS = ((): BlockViewState | undefined => {
    if (forkKey) {
      try {
        const raw = localStorage.getItem(forkKey);
        if (raw) return JSON.parse(raw) as BlockViewState;
      } catch {
        /* fall through to canonical */
      }
    }
    return (props.view_state as BlockViewState | undefined) ?? undefined;
  })();
  const { sorted, toolbar, active: sortActive, renderList } = useBlockView(members, types, {
    enableView: format === "blocks",
    manual: isDynamic ? null : { onMove: moveMember },
    viewState: {
      initial: initialVS,
      onChange: (vs) => {
        if (!forkKey) return;
        try {
          localStorage.setItem(forkKey, JSON.stringify(vs));
        } catch {
          /* ignore */
        }
      },
    },
  });

  const onRemove = (blockId: string) => {
    setMembers((m) => m.filter((x) => x.id !== blockId));
    void api.del(`/collections/${cid}/members/${blockId}`);
  };
  const onMemberChange = (
    blockId: string,
    patch: { properties?: Record<string, unknown>; content?: string | null },
  ) => setMembers((m) => m.map((x) => (x.id === blockId ? { ...x, ...patch } : x)));

  if (members.length === 0) return <div className="hint">Empty.</div>;

  return (
    <>
      {toolbar}
      {format === "blocks" ? (
        renderList((m, compact) => (
          <div className={compact ? undefined : "bv-card-wrap"}>
            {!compact && !isDynamic && (
              <button
                className="icon-btn card-collapse"
                title="Remove from list"
                onClick={() => onRemove(m.id)}
              >
                <X size={14} />
              </button>
            )}
            <BlockCard
              block={m as unknown as Block}
              type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
              onConflict={reload}
              onDeleted={onRemove}
              compact={compact}
            />
          </div>
        ))
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(e) => {
            const { active, over } = e;
            if (over && active.id !== over.id && !isDynamic && !sortActive)
              moveMember(String(active.id), String(over.id));
          }}
        >
          <SortableContext items={sorted.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <div className="list-items">
              {sorted.map((m, i) => (
                <ListItem
                  key={m.id}
                  member={m}
                  type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
                  index={i}
                  format={format}
                  syncStatus={syncStatus}
                  collectionId={cid}
                  onRemove={onRemove}
                  onMemberChange={onMemberChange}
                  readonly={isDynamic || sortActive}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </>
  );
}

/**
 * Renders a collection inside a Today sheet or a document — in its natural
 * form: lists keep their format and the Block/Masonry/Chips toolbar, tables
 * render as tables, matrices as grids; documents stay a stack of cards.
 * Nested collection members are shown as a link rather than recursed.
 */
export function CollectionSection({
  collectionId,
  types,
  reportLabel,
  host,
}: {
  collectionId: string;
  types: BlockType[];
  reportLabel?: (label: string) => void;
  host?: string;
}) {
  const [state, setState] = useState<{ collection: Collection; members: Member[] } | null>(null);
  const { openBlock } = usePanels();

  const load = useCallback(() => {
    void api
      .get<{ collection: Collection; members: Member[] }>(`/collections/${collectionId}`)
      .then((d) => {
        setState(d);
        reportLabel?.(oneLineText(d.collection.properties) || "Untitled");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId]);
  useEffect(load, [load]);

  const setMembers: SetMembers = (fn) =>
    setState((s) => (s ? { ...s, members: fn(s.members) } : s));

  if (!state) return null;
  const kind = state.collection.collectionKind;
  const typeById = new Map(types.map((t) => [t.id, t]));
  const title = oneLineText(state.collection.properties) || "Untitled";
  return (
    <section className="today-section">
      <h2 className="today-h sec-head">
        <span className="sec-title">{title}</span>
        <button
          className="icon-btn sec-open-btn"
          title="Open collection"
          onClick={() => openBlock(collectionId, { collection: true })}
        >
          <Maximize2 size={14} />
        </button>
      </h2>
      {kind === "matrix" ? (
        <div className="matrix-embed">
          <MatrixView collection={state.collection} members={state.members} types={types} onChanged={load} />
        </div>
      ) : kind === "table" ? (
        <TableView
          collection={state.collection}
          members={state.members}
          types={types}
          onChanged={load}
          onMemberChange={(id, patch) =>
            setMembers((m) => m.map((x) => (x.id === id ? { ...x, ...patch } : x)))
          }
        />
      ) : kind === "list" ? (
        <ListBody
          collection={state.collection}
          members={state.members}
          setMembers={setMembers}
          types={types}
          reload={load}
          host={host}
        />
      ) : state.members.length === 0 ? (
        <div className="hint">Empty.</div>
      ) : (
        state.members.map((m) =>
          m.collectionKind ? (
            <Link key={m.id} className="sec-sublink" to={`/collections/${m.id}`}>
              {oneLineText(m.properties) || "Untitled collection"} ↗
            </Link>
          ) : (
            <BlockCard
              key={m.id}
              block={m as unknown as Block}
              type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
              onConflict={() => {}}
              onDeleted={() => {}}
            />
          ),
        )
      )}
    </section>
  );
}
