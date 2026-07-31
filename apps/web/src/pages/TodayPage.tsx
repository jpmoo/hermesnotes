import type { TodayLayout, TodayScope, TodaySection } from "@hermes/shared";
import { Archive, CalendarDays, Maximize2, Trash2 } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollapsibleCard, useCollapse } from "../components/CollapsibleCard.tsx";
import { CollectionSection } from "../components/CollectionSection.tsx";
import { SectionLayout, type SectionEntry } from "../components/SectionLayout.tsx";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";
import { TodayCalendar } from "../components/TodayCalendar.tsx";
import { oneLineText } from "../lib/display.ts";
import { resolveRef, type RefStatus } from "../lib/resolve-ref.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";
import { useOriginScroll } from "../lib/origin-scroll.ts";

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
  const [ref, setRef] = useState<{ status: RefStatus; block: Block | null } | "loading">("loading");
  const reload = useCallback(() => {
    setRef("loading");
    void resolveRef(blockId).then((r) => {
      setRef(r);
      if (r.block) reportLabel(oneLineText(r.block.properties, r.block.content) || "Untitled");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId]);
  useEffect(reload, [reload]);
  const { openBlock } = usePanels();
  if (ref === "loading") return null;
  if (ref.status === "error") return null; // transient — hide, retries on next reload
  if (ref.status === "missing" || !ref.block) {
    return (
      <section className="today-section note-embed">
        <div className="ref-missing">
          <Trash2 size={15} />
          <span>This note no longer exists — remove it from the layout in the panel.</span>
        </div>
      </section>
    );
  }
  const block = ref.block;
  const typeById = new Map(types.map((t) => [t.id, t]));
  return (
    <section className="today-section note-embed" data-block-id={blockId}>
      <button
        className="icon-btn sec-open-btn note-open-btn"
        title="Open note"
        onClick={() => openBlock(blockId)}
      >
        <Maximize2 size={14} />
      </button>
      {ref.status === "archived" && (
        <div className="archived-banner">
          <Archive size={14} />
          <span>This note is archived.</span>
        </div>
      )}
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
  // Today add/remove carry a temporal scope; the server applies it (per-day
  // layout, the cross-day default, or a per-day suppression) and returns the
  // recomposed sheet, so we reload after.
  const scopedSection = (id: string): { t: "collection" | "block"; id: string } | null => {
    const i = id.indexOf(":");
    const t = id.slice(0, i);
    return i > 0 && (t === "collection" || t === "block") ? { t, id: id.slice(i + 1) } : null;
  };
  const onRemove = (id: string, scope?: TodayScope) => {
    const section = scopedSection(id);
    // A collection/note section always goes through the endpoint, even with no
    // scope given. Rewriting the day's layout without it looks right but doesn't
    // stick when a cross-day default put it there: the sheet is recomposed from
    // those defaults, so the section comes straight back and the X appears dead.
    // The endpoint drops a day-local add AND suppresses a covering default.
    if (!section) return saveLayout(layout.filter((s) => idOf(s) !== id));
    void api
      .post(`/today/${date}/layout/remove`, { section, scope: scope ?? "today" })
      .then(load)
      .catch(() => {});
  };
  const onAddCollection = (cid: string, scope: TodayScope = "today") => {
    void api
      .post(`/today/${date}/layout/add`, { section: { t: "collection", id: cid }, scope })
      .then(load)
      .catch(() => {});
  };
  const onAddNote = (bid: string, scope: TodayScope = "today") => {
    void api
      .post(`/today/${date}/layout/add`, { section: { t: "block", id: bid }, scope })
      .then(load)
      .catch(() => {});
  };

  // Arriving from something the day shows — an embedded collection, a note
  // section, the scratchpad itself — puts it back in front of you.
  useOriginScroll(!loading && sheet != null);

  const relevantView = useBlockView(sheet?.relevant ?? [], types, { scope: "today-relevant" });
  const activityView = useBlockView(sheet?.activity ?? [], types, { scope: "today-activity" });
  // Relevant/created cards default to collapsed and remember each block's choice
  // across days (stable scope keys, id→collapsed map in localStorage).
  const relevantCollapse = useCollapse((sheet?.relevant ?? []).map((b) => b.id), "today-relevant", {
    defaultCollapsed: true,
  });
  const activityCollapse = useCollapse((sheet?.activity ?? []).map((b) => b.id), "today-activity", {
    defaultCollapsed: true,
  });
  const cardWith =
    (col: ReturnType<typeof useCollapse>) => (b: Block, compact: boolean) => (
      <CollapsibleCard
        block={b}
        type={typeById.get(b.blockTypeId)}
        compact={compact}
        collapsed={col.collapsed.has(b.id)}
        onToggle={() => col.toggle(b.id)}
        onConflict={load}
        onDeleted={() => void load()}
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
          <section key="scratchpad" className="today-section" data-block-id={sheet.note.id}>
            <h2 className="today-h">Scratchpad</h2>
            <TextBlockEditor
              key={sheet.note.id}
              block={sheet.note}
              type={typeById.get(sheet.note.blockTypeId)}
              onConflict={load}
              onDeleted={load}
              canDelete={false}
              hideBanner
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
                <div className="row" style={{ gap: 12, marginBottom: 8 }}>
                  {relevantView.toolbar}
                  {relevantView.viewMode !== "chips" && (
                    <button className="ghost" onClick={relevantCollapse.toggleAll}>
                      {relevantCollapse.allCollapsed ? "Expand all" : "Collapse all"}
                    </button>
                  )}
                </div>
                {relevantView.renderList(cardWith(relevantCollapse))}
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
                <div className="row" style={{ gap: 12, marginBottom: 8 }}>
                  {activityView.toolbar}
                  {activityView.viewMode !== "chips" && (
                    <button className="ghost" onClick={activityCollapse.toggleAll}>
                      {activityCollapse.allCollapsed ? "Expand all" : "Collapse all"}
                    </button>
                  )}
                </div>
                {activityView.renderList(cardWith(activityCollapse))}
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
          // `order` keeps this last in the panel's bottom slot, so it never
          // splits another block's panel tools (e.g. an embedded matrix's grid
          // controls) that portal into the same slot.
          <div className="panel-slot-last">
            <div className="panel-divider" />
            <div className="panel-h">Daily Note Layout</div>
            <SectionLayout
              entries={entries}
              canReorder
              canModify
              scoped
              onMove={onMove}
              onRemove={onRemove}
              onAddCollection={onAddCollection}
              onAddNote={onAddNote}
            />
          </div>,
          bottomSlotEl,
        )}
    </>
  );
}
