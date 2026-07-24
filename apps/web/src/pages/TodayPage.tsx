import type { TodayLayout, TodaySection } from "@hermes/shared";
import { CalendarDays, Maximize2 } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollectionSection } from "../components/CollectionSection.tsx";
import { SectionLayout, type SectionEntry } from "../components/SectionLayout.tsx";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";
import { TodayCalendar } from "../components/TodayCalendar.tsx";
import { oneLineText } from "../lib/display.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
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
  const { openBlock } = usePanels();
  if (!block) return null;
  const typeById = new Map(types.map((t) => [t.id, t]));
  return (
    <section className="today-section note-embed">
      <button
        className="icon-btn sec-open-btn note-open-btn"
        title="Open note"
        onClick={() => openBlock(blockId)}
      >
        <Maximize2 size={14} />
      </button>
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
  const [failed, setFailed] = useState(false);
  const { slotEl, bottomSlotEl, setHasContent, selectToday, selectedToday } = usePanels();
  const { banner, setBanner } = usePreferences();
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
    setFailed(false);
    load()
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    setHasContent(true);
    return () => setHasContent(false);
  }, [setHasContent]);

  // Give the Today page its own info block (the day's note), recorded in recents
  // by date. Runs on date/note change only; skip if already this day's entry so
  // selecting a card on the page doesn't snap back.
  const selRef = useRef(selectedToday);
  selRef.current = selectedToday;
  const noteId = sheet?.note?.id;
  useEffect(() => {
    if (noteId && selRef.current !== date) selectToday(date, noteId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, noteId]);

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

  const relevantView = useBlockView(sheet?.relevant ?? [], types, { scope: "today-relevant" });
  const activityView = useBlockView(sheet?.activity ?? [], types, { scope: "today-activity" });
  const card = (b: Block, compact: boolean) => (
    <BlockCard
      block={b}
      type={typeById.get(b.blockTypeId)}
      onConflict={load}
      onDeleted={() => void load()}
      compact={compact}
    />
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
            <TextBlockEditor
              key={sheet.note.id}
              block={sheet.note}
              type={typeById.get(sheet.note.blockTypeId)}
              onConflict={load}
              onDeleted={load}
              canDelete={false}
            />
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
            host="today"
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
      {(banner("today") as BannerValue | null) && (
        <Banner
          value={banner("today") as BannerValue}
          editable
          onChange={(v) => setBanner("today", v)}
        />
      )}
      <div className="page-head">
        <h1 className="page-title title-with-icon">
        <CalendarDays size={22} color="#26282b" />
        {isToday ? `Today · ${label}` : label}
      </h1>
        {!(banner("today")) && (
          <BannerAddButton className="page-head-add" onAdded={(v) => setBanner("today", v)} />
        )}
      </div>
      {!isToday && (
        <p className="page-sub">
          <Link to="/today">back to today</Link>
        </p>
      )}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : failed || !sheet ? (
        <div className="hint">
          Couldn’t load this day.{" "}
          <button
            className="ghost"
            onClick={() => {
              setLoading(true);
              setFailed(false);
              void load()
                .catch(() => setFailed(true))
                .finally(() => setLoading(false));
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        layout.map(renderSection)
      )}

      {slotEl &&
        createPortal(
          <>
            <TodayCalendar selected={date} />
            <div className="panel-divider" />
          </>,
          slotEl,
        )}
      {bottomSlotEl &&
        createPortal(
          <>
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
          bottomSlotEl,
        )}
    </>
  );
}
