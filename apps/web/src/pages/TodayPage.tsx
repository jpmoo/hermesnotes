import { CalendarDays } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";
import { TodayCalendar } from "../components/TodayCalendar.tsx";
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
}

export function TodayPage() {
  const { date: dateParam } = useParams();
  const date = dateParam ?? todayStr();
  const isToday = date === todayStr();

  const [sheet, setSheet] = useState<TodaySheet | null>(null);
  const [types, setTypes] = useState<BlockType[]>([]);
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

  // Offer the month calendar in the right panel.
  useEffect(() => {
    setHasContent(true);
    setTitle("Calendar");
    return () => setHasContent(false);
  }, [setHasContent, setTitle]);

  const onDeleted = (id: string) =>
    setSheet((s) =>
      s
        ? {
            ...s,
            relevant: s.relevant.filter((b) => b.id !== id),
            activity: s.activity.filter((b) => b.id !== id),
          }
        : s,
    );

  const label = new Date(`${date}T00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const relevantView = useBlockView(sheet?.relevant ?? [], types);
  const activityView = useBlockView(sheet?.activity ?? [], types);
  const card = (b: Block) => (
    <BlockCard
      block={b}
      type={typeById.get(b.blockTypeId)}
      onConflict={load}
      onDeleted={onDeleted}
    />
  );

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

      {loading || !sheet ? (
        <div className="hint">Loading…</div>
      ) : (
        <>
          <section className="today-section">
            <h2 className="today-h">Scratchpad</h2>
            <TextBlockEditor key={sheet.note.id} block={sheet.note} onConflict={load} onDeleted={load} />
          </section>

          <section className="today-section">
            <h2 className="today-h">Relevant today</h2>
            {sheet.relevant.length === 0 ? (
              <div className="hint">Nothing dated to this day.</div>
            ) : (
              <>
                {relevantView.toolbar}
                {relevantView.renderList(card)}
              </>
            )}
          </section>

          <section className="today-section">
            <h2 className="today-h">Created or edited today</h2>
            {sheet.activity.length === 0 ? (
              <div className="hint">No activity on this day.</div>
            ) : (
              <>
                {activityView.toolbar}
                {activityView.renderList(card)}
              </>
            )}
          </section>
        </>
      )}

      {slotEl && createPortal(<TodayCalendar selected={date} />, slotEl)}
    </>
  );
}
