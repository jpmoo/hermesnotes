import type { TodayLayout, TodaySection } from "@hermes/shared";
import { CalendarDays } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollectionSection } from "../components/CollectionSection.tsx";
import { SectionLayout, type SectionEntry } from "../components/SectionLayout.tsx";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";
import { TodayCalendar } from "../components/TodayCalendar.tsx";
import { oneLineText } from "../lib/display.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";

const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

interface TodaySheet {
  note: Block;
  relevant: Block[];
  activity: Block[];
  layout: TodayLayout;
}

const idOf = (s: TodaySection) => (s.t === "collection" || s.t === "block" ? `${s.t}:${s.id}` : s.t);

/** An added note section: a single block rendered as a card. */
function NoteSection({
  blockId,
  types,
  reportLabel,
  onGone,
}: {
  blockId: string;
  types: BlockType[];
  reportLabel: (label: string) => void;
  onGone: () => void;
}) {
  const [block, setBlock] = useState<Block | null>(null);
  const reload = useCallback(() => {
    void api
      .get<Block>(`/blocks/${blockId}`)
      .then((b) => {
        setBlock(b);
        reportLabel(oneLineText(b.properties, b.content) || "Untitled");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);
  useEffect(reload, [reload]);
  if (!block) return null;
  const typeById = new Map(types.map((t) => [t.id, t]));
  return (
    <section className="today-section">
      <BlockCard
        block={block}
        type={typeById.get(block.blockTypeId)}
        onConflict={reload}
        onDeleted={onGone}
      />
    </section>
  );
}

export function TodayPage() {
  const { date: dateParam } = useParams();
  const date = dateParam ?? todayStr();
  const isToday = date === todayStr();

  const [sheet, setSheet] = useState<TodaySheet | null>(null);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const { slotEl, setTitle, setHasContent } = usePanels();
  const typeById = new Map(types.map((t) => [t.id, t]));

  const load = useCallback(async () => {
    const [data, ts] = await Promise.all([
      api.get<TodaySheet>(`/today/${date}`),
      api.get<BlockType[]>("/block-types"),
    ]);
    setSheet(data);
    setTypes(ts);
  }, [date]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    setHasContent(true);
    setTitle("Today");
    return () => setHasContent(false);
  }, [setHasContent, setTitle]);

  const layout = sheet?.layout ?? [];
  const saveLayout = (next: TodayLayout) => {
    setSheet((s) => (s ? { ...s, layout: next } : s));
    void api.put(`/today/${date}/layout`, { layout: next });
  };
  const onMove = (activeId: string, overId: string) => {
    const arr = [...layout];
    const from = arr.findIndex((s) => idOf(s) === activeId);
    const to = arr.findIndex((s) => idOf(s) === overId);
    if (from < 0 || to < 0) return;
    const [moved] = arr.splice(from, 1);
    if (moved) arr.splice(to, 0, moved);
    saveLayout(arr);
  };
  const onRemove = (id: string) => saveLayout(layout.filter((s) => idOf(s) !== id));
  const onAddCollection = (cid: string) => {
    if (!layout.some((s) => s.t === "collection" && s.id === cid))
      saveLayout([...layout, { t: "collection", id: cid }]);
  };
  const onAddNote = (bid: string) => {
    if (!layout.some((s) => s.t === "block" && s.id === bid))
      saveLayout([...layout, { t: "block", id: bid }]);
  };

  const relevantView = useBlockView(sheet?.relevant ?? [], types);
  const activityView = useBlockView(sheet?.activity ?? [], types);
  const card = (b: Block) => (
    <BlockCard block={b} type={typeById.get(b.blockTypeId)} onConflict={load} onDeleted={() => void load()} />
  );

  const STANDARD_LABELS: Record<string, string> = {
    scratchpad: "Scratchpad",
    relevant: "Relevant today",
    activity: "Created or edited today",
  };
  const entries: SectionEntry[] = layout.map((s) => {
    const id = idOf(s);
    if (s.t === "collection" || s.t === "block") {
      return { id, label: labels[id] ?? (s.t === "collection" ? "Collection…" : "Note…"), removable: true };
    }
    return { id, label: STANDARD_LABELS[s.t] ?? s.t, removable: false };
  });

  const label = new Date(`${date}T00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const renderSection = (s: TodaySection) => {
    switch (s.t) {
      case "scratchpad":
        return sheet ? (
          <section key="scratchpad" className="today-section">
            <h2 className="today-h">Scratchpad</h2>
            <TextBlockEditor key={sheet.note.id} block={sheet.note} onConflict={load} onDeleted={load} />
          </section>
        ) : null;
      case "relevant":
        return (
          <section key="relevant" className="today-section">
            <h2 className="today-h">Relevant today</h2>
            {sheet && sheet.relevant.length === 0 ? (
              <div className="hint">Nothing dated to this day.</div>
            ) : (
              <>
                {relevantView.toolbar}
                {relevantView.renderList(card)}
              </>
            )}
          </section>
        );
      case "activity":
        return (
          <section key="activity" className="today-section">
            <h2 className="today-h">Created or edited today</h2>
            {sheet && sheet.activity.length === 0 ? (
              <div className="hint">No activity on this day.</div>
            ) : (
              <>
                {activityView.toolbar}
                {activityView.renderList(card)}
              </>
            )}
          </section>
        );
      case "collection":
        return (
          <CollectionSection
            key={`c${s.id}`}
            collectionId={s.id}
            types={types}
            reportLabel={(l) => setLabels((m) => ({ ...m, [`collection:${s.id}`]: l }))}
          />
        );
      case "block":
        return (
          <NoteSection
            key={`b${s.id}`}
            blockId={s.id}
            types={types}
            reportLabel={(l) => setLabels((m) => ({ ...m, [`block:${s.id}`]: l }))}
            onGone={() => onRemove(`block:${s.id}`)}
          />
        );
    }
  };

  return (
    <>
      <h1 className="page-title title-with-icon">
        <CalendarDays size={22} color="#26282b" />
        {isToday ? "Today" : "Day"}
      </h1>
      <p className="page-sub">
        {label}
        {!isToday && (
          <>
            {" · "}
            <Link to="/today">back to today</Link>
          </>
        )}
      </p>

      {loading || !sheet ? <div className="hint">Loading…</div> : layout.map(renderSection)}

      {slotEl &&
        createPortal(
          <>
            <TodayCalendar selected={date} />
            <div className="panel-divider" />
            <div className="panel-h">Layout</div>
            <SectionLayout
              entries={entries}
              canReorder
              canModify
              onMove={onMove}
              onRemove={onRemove}
              onAddCollection={onAddCollection}
              onAddNote={onAddNote}
            />
          </>,
          slotEl,
        )}
    </>
  );
}
