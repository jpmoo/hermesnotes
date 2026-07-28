import { CheckCircle2, ChevronRight, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollectionSection } from "../components/CollectionSection.tsx";
import { ReviewSteps } from "../components/ReviewSteps.tsx";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { reviewApi, WEEKDAYS, type ReviewState, type ReviewStepView } from "../lib/review.ts";

const fmtLong = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

/** The linked block/collection for a step (or the outside-step note). */
function StepContent({ step, types }: { step: ReviewStepView; types: BlockType[] }) {
  const [block, setBlock] = useState<Block | null>(null);
  const isBlock = step.link?.t === "block";
  const reload = useCallback(() => {
    if (!isBlock || !step.link) return;
    void api.get<Block>(`/blocks/${step.link.id}`).then(setBlock).catch(() => setBlock(null));
  }, [isBlock, step.link]);
  useEffect(reload, [reload]);

  if (!step.link) {
    return (
      <div className="review-outside">
        <ExternalLink size={16} />
        <span>Tackle this step outside of Hermes Notes. Return and check it off when it’s completed.</span>
      </div>
    );
  }
  if (step.link.t === "collection") {
    return <CollectionSection collectionId={step.link.id} types={types} host="review" />;
  }
  if (!block) return <div className="hint">Loading…</div>;
  return (
    <BlockCard
      block={block}
      type={types.find((t) => t.id === block.blockTypeId)}
      onConflict={reload}
      onDeleted={() => setBlock(null)}
    />
  );
}

/** Scratchpad-style reflection editor for the week (a real, titled note block). */
function Reflection({ blockId, title, types }: { blockId: string; title: string; types: BlockType[] }) {
  const [block, setBlock] = useState<Block | null>(null);
  const reload = useCallback(() => {
    void api.get<Block>(`/blocks/${blockId}`).then(setBlock).catch(() => {});
  }, [blockId]);
  useEffect(reload, [reload]);
  if (!block) return null;
  return (
    <section className="review-reflection">
      <div className="panel-h" style={{ marginTop: 0 }}>{title}</div>
      <TextBlockEditor
        block={block}
        type={types.find((t) => t.id === block.blockTypeId)}
        onConflict={reload}
        onDeleted={() => {}}
      />
    </section>
  );
}

export function ReviewPage() {
  const [state, setState] = useState<ReviewState | null>(null);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const { bottomSlotEl, setHasContent } = usePanels();

  const load = useCallback(() => void reviewApi.get().then(setState).catch(() => setState(null)), []);
  useEffect(() => {
    load();
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
  }, [load]);
  useEffect(() => {
    setHasContent(true);
    return () => setHasContent(false);
  }, [setHasContent]);

  const steps = state?.configured ? state.steps : [];
  // Default the cursor to the first unfinished step (or the first).
  useEffect(() => {
    if (!steps.length) {
      setCurrentId(null);
      return;
    }
    if (!currentId || !steps.some((s) => s.id === currentId)) {
      setCurrentId((steps.find((s) => !s.done) ?? steps[0]!).id);
    }
  }, [steps, currentId]);

  /** Complete the managed task (also fires when the last step is checked). */
  const completeTask = useCallback(async (taskId: string) => {
    const b = await api.get<Block>(`/blocks/${taskId}`);
    await api.patch(`/blocks/${taskId}`, {
      properties: { ...((b.properties ?? {}) as Record<string, unknown>), status: "done" },
      version: b.version,
    });
    load();
  }, [load]);

  const toggleDone = async (id: string, done: boolean) => {
    const next = await reviewApi.setDone(id, done);
    setState(next);
    if (done) {
      // Advance to the next unfinished step.
      const order = next.configured ? next.steps : [];
      const idx = order.findIndex((s) => s.id === id);
      const following = [...order.slice(idx + 1), ...order.slice(0, idx + 1)].find((s) => !s.done);
      if (following) setCurrentId(following.id);
      if (next.configured && next.allDone && next.task && next.task.status !== "done")
        await completeTask(next.task.id);
    }
  };

  const mutate = (p: Promise<ReviewState>) => void p.then(setState).catch(() => {});

  if (!state) return <div className="hint">Loading…</div>;
  if (!state.configured) {
    return (
      <div className="review-page">
        <h1 className="page-title">Weekly Review</h1>
        <p className="page-sub">
          No review day set yet. Choose one in <Link to="/settings">Settings → Weekly Review</Link>.
        </p>
      </div>
    );
  }

  const current = steps.find((s) => s.id === currentId) ?? steps[0] ?? null;
  const doneCount = steps.filter((s) => s.done).length;
  const taskDone = state.task?.status === "done";

  return (
    <div className="review-page">
      <h1 className="page-title">Weekly Review</h1>
      <p className="page-sub">
        Due {state.task?.due ? fmtLong(state.task.due) : WEEKDAYS[state.dueWeekday]}
        {" · "}
        {taskDone
          ? "done for this week 🎉"
          : state.open
            ? `${doneCount}/${steps.length} steps done`
            : state.task?.available
              ? `opens ${fmtLong(state.task.available)}`
              : "not open yet"}
      </p>

      {state.reflectionBlockId && (
        <Reflection blockId={state.reflectionBlockId} title={state.reflectionTitle} types={types} />
      )}

      {current ? (
        <section className="review-current">
          <div className="review-current-head">
            <h2>{current.description.trim() || current.label || "Step"}</h2>
            {!current.done && (
              <button className="primary" onClick={() => void toggleDone(current.id, true)}>
                Done <ChevronRight size={15} />
              </button>
            )}
          </div>
          <StepContent step={current} types={types} />
        </section>
      ) : (
        <div className="hint">Add your first step in the panel on the right.</div>
      )}

      {!taskDone && state.allDone && state.task && (
        <button className="primary review-complete" onClick={() => void completeTask(state.task!.id)}>
          <CheckCircle2 size={16} /> Complete this review
        </button>
      )}

      {bottomSlotEl &&
        createPortal(
          <>
            <div className="panel-divider" />
            <div className="panel-h">Steps</div>
            <ReviewSteps
              steps={steps}
              currentId={currentId}
              onSelect={setCurrentId}
              onToggleDone={(id, done) => void toggleDone(id, done)}
              onReorder={(ids) => mutate(reviewApi.reorder(ids))}
              onRemove={(id) => mutate(reviewApi.removeStep(id))}
              onAdd={(step) => mutate(reviewApi.addStep(step))}
            />
          </>,
          bottomSlotEl,
        )}
    </div>
  );
}
