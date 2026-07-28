import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CheckSquare, GripVertical, Link2, Plus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type BlockSearchResult, type BlockType, type Collection } from "../api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import type { NewStep, ReviewLink, ReviewStepView } from "../lib/review.ts";

/** Icon for a collection given its kind (+ smart mode), mirroring the app's pickers. */
function collectionIcon(kind: string | null, smart: boolean, color: string | null) {
  return (
    <CollectionIcon
      document={kind === "document"}
      matrix={kind === "matrix"}
      table={kind === "table"}
      canvas={kind === "canvas"}
      calendar={kind === "calendar"}
      smart={smart}
      color={color}
      size={15}
    />
  );
}

const stepLabel = (s: ReviewStepView): string => s.description.trim() || s.label || "Untitled step";

/** The compact link picker: none / block / collection. */
function LinkPicker({
  value,
  onChange,
  initialLabel,
}: {
  value: ReviewLink | null;
  onChange: (v: ReviewLink | null) => void;
  initialLabel?: string;
}) {
  const [mode, setMode] = useState<"none" | "block" | "collection">(value?.t ?? "none");
  const [collections, setCollections] = useState<Collection[]>([]);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [q, setQ] = useState(value?.t === "block" ? initialLabel ?? "" : "");
  const [results, setResults] = useState<BlockSearchResult[]>([]);

  useEffect(() => {
    if (mode === "collection" && collections.length === 0)
      void api.get<Collection[]>("/collections").then(setCollections).catch(() => {});
    if (mode === "block" && types.length === 0)
      void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
  }, [mode, collections.length, types.length]);

  useEffect(() => {
    if (mode !== "block") return;
    const t = setTimeout(() => {
      if (q.trim())
        void api.get<BlockSearchResult[]>(`/blocks/search?q=${encodeURIComponent(q)}`).then(setResults).catch(() => {});
      else setResults([]);
    }, 200);
    return () => clearTimeout(t);
  }, [q, mode]);

  const pick = (m: "none" | "block" | "collection") => {
    setMode(m);
    if (m === "none") onChange(null);
  };

  return (
    <div className="review-linkpick">
      <div className="seg">
        {(["none", "block", "collection"] as const).map((m) => (
          <button key={m} className={`seg-btn${mode === m ? " active" : ""}`} onClick={() => pick(m)} type="button">
            {m === "none" ? "Outside" : m === "block" ? "Block" : "Collection"}
          </button>
        ))}
      </div>
      {mode === "block" && (
        <>
          <input placeholder="Search blocks…" value={q} onChange={(e) => setQ(e.target.value)} />
          {results.length > 0 && (
            <div className="review-linkmenu">
              {results.slice(0, 8).map((r) => {
                const t = r.blockTypeId ? types.find((x) => x.id === r.blockTypeId) : undefined;
                return (
                  <button
                    key={r.id}
                    className="menu-item type-item"
                    type="button"
                    onClick={() => {
                      onChange({ t: "block", id: r.id });
                      setResults([]);
                      setQ(r.label || "Untitled");
                    }}
                  >
                    {r.collectionKind ? (
                      collectionIcon(r.collectionKind, false, null)
                    ) : (
                      <BlockIcon
                        iconKey={!t || t.isText ? "type" : t.iconKey}
                        color={t && !t.isText ? t.iconColor : null}
                        size={15}
                      />
                    )}
                    <span className="sec-add-label">{r.label || "Untitled"}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
      {mode === "collection" && (
        <div className="review-linkmenu">
          {collections.map((c) => (
            <button
              key={c.id}
              className={`menu-item type-item${value?.t === "collection" && value.id === c.id ? " active" : ""}`}
              type="button"
              onClick={() => onChange({ t: "collection", id: c.id })}
            >
              {collectionIcon(
                c.collectionKind,
                c.properties.membership_mode === "smart",
                (c.properties.icon_color as string) ?? null,
              )}
              <span className="sec-add-label">{String(c.properties.title ?? "Untitled")}</span>
            </button>
          ))}
          {collections.length === 0 && (
            <div className="hint" style={{ padding: "4px 6px" }}>
              No collections yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Shared description + link fields, used by both the add form and inline edit. */
function StepFields({
  description,
  setDescription,
  link,
  setLink,
  initialLabel,
}: {
  description: string;
  setDescription: (v: string) => void;
  link: ReviewLink | null;
  setLink: (v: ReviewLink | null) => void;
  initialLabel?: string;
}) {
  return (
    <>
      <textarea
        className="review-adddesc"
        placeholder="Describe this step…"
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <LinkPicker value={link} onChange={setLink} initialLabel={initialLabel} />
    </>
  );
}

function Row({
  step,
  current,
  locked,
  onSelect,
  onToggleDone,
  onRemove,
}: {
  step: ReviewStepView;
  current: boolean;
  locked: boolean;
  onSelect: (id: string) => void;
  onToggleDone: (id: string, done: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const sortable = useSortable({ id: step.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const [confirmDel, setConfirmDel] = useState(false);

  return (
    <div ref={sortable.setNodeRef} style={style} className={`sec-row review-step-row${current ? " current" : ""}`}>
      <button className="drag-handle" {...sortable.attributes} {...sortable.listeners} title="Drag to reorder">
        <GripVertical size={14} />
      </button>
      <button
        className="review-step-check"
        title={locked ? "Opens on the review's available date" : step.done ? "Mark not done" : "Mark done"}
        disabled={locked}
        onClick={() => onToggleDone(step.id, !step.done)}
      >
        {step.done ? <CheckSquare size={16} /> : <Square size={16} />}
      </button>
      <button className={`sec-label review-step-label${step.done ? " done" : ""}`} onClick={() => onSelect(step.id)}>
        {step.link && <Link2 size={11} className="review-step-linkicon" />}
        {stepLabel(step)}
      </button>
      <button className="icon-btn sec-remove" title="Remove step" onClick={() => setConfirmDel(true)}>
        <X size={13} />
      </button>
      <ConfirmDialog
        open={confirmDel}
        title="Remove step?"
        message="This removes the step from the review. It can't be undone (re-add it if needed)."
        confirmLabel="Remove"
        onConfirm={() => {
          setConfirmDel(false);
          onRemove(step.id);
        }}
        onCancel={() => setConfirmDel(false)}
      />
    </div>
  );
}

function AddStepForm({ onAdd, onCancel }: { onAdd: (s: NewStep) => void; onCancel: () => void }) {
  const [description, setDescription] = useState("");
  const [link, setLink] = useState<ReviewLink | null>(null);
  const [scope, setScope] = useState<"template" | "cycle">("template");
  return (
    <div className="review-addform">
      <StepFields description={description} setDescription={setDescription} link={link} setLink={setLink} />
      <label className="field">
        <span>Add to</span>
        <select value={scope} onChange={(e) => setScope(e.target.value as "template" | "cycle")}>
          <option value="template">This and all future reviews</option>
          <option value="cycle">This review only</option>
        </select>
      </label>
      <div className="row" style={{ gap: 8 }}>
        <button
          className="primary"
          type="button"
          disabled={!description.trim() && !link}
          onClick={() => onAdd({ description: description.trim(), link, scope })}
        >
          Add step
        </button>
        <button className="ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The weekly-review step builder + stepper, shown in the info panel. */
export function ReviewSteps({
  steps,
  currentId,
  locked,
  onSelect,
  onToggleDone,
  onReorder,
  onRemove,
  onAdd,
}: {
  steps: ReviewStepView[];
  currentId: string | null;
  /** Before the review opens: progress (done boxes) is read-only; you can still
   *  build the step list. */
  locked: boolean;
  onSelect: (id: string) => void;
  onToggleDone: (id: string, done: boolean) => void;
  onReorder: (ids: string[]) => void;
  onRemove: (id: string) => void;
  onAdd: (step: NewStep) => void;
}) {
  const [adding, setAdding] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = steps.map((s) => s.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    onReorder(ids);
  };

  return (
    <div className="review-steps">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {steps.map((s) => (
            <Row
              key={s.id}
              step={s}
              current={s.id === currentId}
              locked={locked}
              onSelect={onSelect}
              onToggleDone={onToggleDone}
              onRemove={onRemove}
            />
          ))}
        </SortableContext>
      </DndContext>
      {steps.length === 0 && <div className="hint" style={{ padding: "4px 2px" }}>No steps yet — add your first.</div>}

      {adding ? (
        <AddStepForm
          onAdd={(s) => {
            onAdd(s);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button className="ghost review-addbtn" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add step
        </button>
      )}
    </div>
  );
}
