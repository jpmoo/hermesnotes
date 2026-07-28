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
import { CheckSquare, GripVertical, Link2, Pencil, Plus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type BlockSearchResult, type Collection } from "../api.ts";
import type { NewStep, ReviewLink, ReviewStepView } from "../lib/review.ts";

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
  const [q, setQ] = useState(value?.t === "block" ? initialLabel ?? "" : "");
  const [results, setResults] = useState<BlockSearchResult[]>([]);

  useEffect(() => {
    if (mode === "collection" && collections.length === 0)
      void api.get<Collection[]>("/collections").then(setCollections).catch(() => {});
  }, [mode, collections.length]);

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
            <div className="menu review-linkmenu">
              {results.slice(0, 8).map((r) => (
                <button
                  key={r.id}
                  className="menu-item"
                  type="button"
                  onClick={() => {
                    onChange({ t: "block", id: r.id });
                    setResults([]);
                    setQ(r.label || "Untitled");
                  }}
                >
                  {r.label || "Untitled"}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {mode === "collection" && (
        <select
          value={value?.t === "collection" ? value.id : ""}
          onChange={(e) => onChange(e.target.value ? { t: "collection", id: e.target.value } : null)}
        >
          <option value="">— select a collection —</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {String(c.properties.title ?? "Untitled")}
            </option>
          ))}
        </select>
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
  onEdit,
}: {
  step: ReviewStepView;
  current: boolean;
  locked: boolean;
  onSelect: (id: string) => void;
  onToggleDone: (id: string, done: boolean) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string, patch: { description: string; link: ReviewLink | null }) => void;
}) {
  const sortable = useSortable({ id: step.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(step.description);
  const [link, setLink] = useState<ReviewLink | null>(step.link);

  if (editing) {
    return (
      <div ref={sortable.setNodeRef} style={style} className="review-addform">
        <StepFields
          description={description}
          setDescription={setDescription}
          link={link}
          setLink={setLink}
          initialLabel={step.label ?? undefined}
        />
        <div className="row" style={{ gap: 8 }}>
          <button
            className="primary"
            type="button"
            onClick={() => {
              onEdit(step.id, { description: description.trim(), link });
              setEditing(false);
            }}
          >
            Save
          </button>
          <button className="ghost" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

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
      <button className="icon-btn sec-remove" title="Edit step" onClick={() => setEditing(true)}>
        <Pencil size={12} />
      </button>
      <button className="icon-btn sec-remove" title="Remove step" onClick={() => onRemove(step.id)}>
        <X size={13} />
      </button>
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
          <option value="template">All future reviews</option>
          <option value="cycle">Just this review</option>
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
  onEdit,
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
  onEdit: (id: string, patch: { description: string; link: ReviewLink | null }) => void;
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
              onEdit={onEdit}
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
