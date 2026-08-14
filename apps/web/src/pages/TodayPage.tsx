import type { TodayLayout, TodayScope, TodaySection } from "@hermes/shared";
import {
  Archive,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Block, type BlockType } from "../api.ts";
import { BlockCard } from "../components/BlockCard.tsx";
import { CollapseAllButton, CollapsibleCard, useCollapse } from "../components/CollapsibleCard.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import type { ShownField } from "../lib/field-text.ts";
import { CollectionSection } from "../components/CollectionSection.tsx";
import { SectionLayout, type SectionEntry } from "../components/SectionLayout.tsx";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";
import { TodayCalendar } from "../components/TodayCalendar.tsx";
import { oneLineText } from "../lib/display.ts";
import { CollectionIcon } from "../lib/icons.tsx";
import { resolveRef, type RefStatus } from "../lib/resolve-ref.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { useBlockView } from "../lib/useBlockView.tsx";
import { emitBlockChange, useBlockDeleted } from "../lib/block-events.ts";
import { useOriginScroll } from "../lib/origin-scroll.ts";
import { AsOfProvider } from "../lib/as-of.tsx";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
/** The day `delta` days from a YYYY-MM-DD date. Built from the parts rather
 * than by adding milliseconds, so the days either side of a clock change are
 * still the days either side. */
const shiftDay = (date: string, delta: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return ymd(new Date(y, m - 1, d + delta));
};

interface TodaySheet {
  note: Block;
  relevant: Block[];
  activity: Block[];
  layout: TodayLayout;
  /** The day is exactly as it opens — nothing written, nothing arranged on it.
   *  Decided by the server, which owns what "untouched" means. */
  pristine?: boolean;
}

const idOf = (s: TodaySection) => (s.t === "collection" || s.t === "block" ? `${s.t}:${s.id}` : s.t);

/** A collection that turned up in a day's activity: a row that opens it. */
function CollectionRow({ block }: { block: Block }) {
  const { selectOrOpen } = usePanels();
  const props = (block.properties ?? {}) as Record<string, unknown>;
  const kind = block.collectionKind ?? "";
  return (
    <button
      className="card today-collection-row"
      onClick={() => selectOrOpen(block.id, { collection: true })}
    >
      <CollectionIcon
        document={kind === "document"}
        matrix={kind === "matrix"}
        table={kind === "table"}
        canvas={kind === "canvas"}
        calendar={kind === "calendar"}
        rollup={kind === "rollup"}
        smart={props.membership_mode === "smart"}
        color={typeof props.icon_color === "string" ? props.icon_color : undefined}
        size={16}
      />
      <span className="today-collection-name">{oneLineText(props) || "Untitled"}</span>
      <span className="hint">{kind || "collection"}</span>
    </button>
  );
}

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
  const nav = useNavigate();
  const date = dateParam ?? todayStr();
  const isToday = date === todayStr();
  const [confirmReset, setConfirmReset] = useState(false);
  // Bumped by a reset, and part of the editor's key: the box has its own copy
  // of the text, and it holds on to it while the caret is in there. Rewriting
  // the note underneath it has to put a new box on the page.
  const [resetNonce, setResetNonce] = useState(0);
  // Today is the day itself, not a date it happens to equal: opening yesterday
  // and stepping forward lands on /today, so the page still says "Today" after
  // midnight rather than freezing on a date that has stopped being it.
  const goToDay = (d: string) => nav(d === todayStr() ? "/today" : `/today/${d}`);

  const [sheet, setSheet] = useState<TodaySheet | null>(null);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  // Which sections stand on every day from here rather than only on this one.
  // The sheet composes both together, so it can't be told from the layout alone.
  const [standingIds, setStandingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Nothing written here and nothing arranged on it: there is nothing to put
  // back, so the reset is dead rather than a no-op that looks like it did
  // something. Assumed while the sheet is still loading.
  const pristine = sheet?.pristine !== false;
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
    if (noteId && selRef.current !== date) selectToday(date, noteId, { quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, noteId]);

  const layout = sheet?.layout ?? [];
  // Read alongside the sheet: the same list, said in terms of where each
  // section comes from.
  useEffect(() => {
    void api
      .get<{ sections: { t: string; id?: string; source?: string }[] }>(
        `/today/${date}/layout`,
      )
      .then((r) =>
        setStandingIds(
          new Set(
            r.sections
              .filter((x) => x.id && x.source === "default")
              .map((x) => `${x.t}:${x.id}`),
          ),
        ),
      )
      .catch(() => {});
  }, [date, sheet?.layout]);
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
  const onRescope = (id: string, standing: boolean) => {
    const section = scopedSection(id);
    if (!section) return;
    void api
      .post(`/today/${date}/layout/rescope`, {
        section,
        scope: standing ? "today_forward" : "today",
      })
      .then(load)
      .catch(() => {});
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

  // Put the day back to the page it would have opened with — the daily template
  // and whatever is being sent forward — and drop the arrangement made for this
  // day alone, so it reads as a day nobody has been to (the calendar included).
  const resetDay = async () => {
    setConfirmReset(false);
    await api.post(`/today/${date}/reset`, {});
    setResetNonce((n) => n + 1);
    if (sheet?.note) emitBlockChange(sheet.note.id, "today-reset");
    await load();
  };

  // Arriving from something the day shows — an embedded collection, a note
  // section, the scratchpad itself — puts it back in front of you.
  useOriginScroll(!loading && sheet != null);

  // Archiving something from anywhere takes it off the day at once, rather
  // than leaving it listed until the next load.
  useBlockDeleted((bid) =>
    setSheet((s) =>
      s
        ? { ...s, relevant: s.relevant.filter((b) => b.id !== bid), activity: s.activity.filter((b) => b.id !== bid) }
        : s,
    ),
  );

  // One row per thing, whatever the server sends: a list that shows the same
  // block twice is worse than one that's a row short, and nothing downstream
  // (sorting, collapse state, drag) expects a repeated id.
  const uniqueById = (rows: Block[]) => {
    const seen = new Set<string>();
    return rows.filter((b) => !seen.has(b.id) && seen.add(b.id));
  };

  const relevantView = useBlockView(uniqueById(sheet?.relevant ?? []), types, { scope: "today-relevant" });
  const activityView = useBlockView(uniqueById(sheet?.activity ?? []), types, { scope: "today-activity" });
  // Relevant/created cards default to collapsed and remember each block's choice
  // across days (stable scope keys, id→collapsed map in localStorage).
  const relevantCollapse = useCollapse((sheet?.relevant ?? []).map((b) => b.id), "today-relevant", {
    defaultCollapsed: true,
  });
  const activityCollapse = useCollapse((sheet?.activity ?? []).map((b) => b.id), "today-activity", {
    defaultCollapsed: true,
  });
  const cardWith =
    (col: ReturnType<typeof useCollapse>, fields: ShownField[]) => (b: Block, compact: boolean) =>
      // A collection isn't editable as a card — it's a place. Show it as a row
      // that opens it, rather than as a text editor over its properties.
      b.collectionKind ? (
        <CollectionRow block={b} />
      ) : (
        <CollapsibleCard
          block={b}
          type={typeById.get(b.blockTypeId)}
          compact={compact}
          collapsed={col.collapsed.has(b.id)}
          onToggle={() => col.toggle(b.id)}
          onConflict={load}
          onDeleted={() => void load()}
          fields={fields}
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
      return {
        id,
        label: labels[id] ?? (s.t === "collection" ? "Collection…" : "Note…"),
        removable: true,
        standing: standingIds.has(id),
      };
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
              key={`${sheet.note.id}:${resetNonce}`}
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
                {relevantView.renderToolbar(
                  relevantView.viewMode !== "chips" && (
                    <CollapseAllButton
                      allCollapsed={relevantCollapse.allCollapsed}
                      onToggle={relevantCollapse.toggleAll}
                    />
                  ),
                )}
                {relevantView.renderList(cardWith(relevantCollapse, relevantView.sortFields))}
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
                {activityView.renderToolbar(
                  activityView.viewMode !== "chips" && (
                    <CollapseAllButton
                      allCollapsed={activityCollapse.allCollapsed}
                      onToggle={activityCollapse.toggleAll}
                    />
                  ),
                )}
                {activityView.renderList(cardWith(activityCollapse, activityView.sortFields))}
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
    // Everything on this page is about this day: embedded queries resolve
    // "today" to it, and date-driven views count from it.
    <AsOfProvider date={date}>
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
        {/* Pinned to the right edge rather than trailing the title: the title
            is a different length every day (and loses "Today ·" the moment you
            step off it), so a control that followed it slid out from under the
            finger clicking through the days. */}
        <div className="page-head-right">
        {!(banner("today")) && (
          <BannerAddButton className="page-head-add" onAdded={(v) => setBanner("today", v)} />
        )}
        <div className="day-nav">
          <div className="segmented day-nav-steps">
            <button
              className="seg seg-icon"
              title="Previous day"
              aria-label="Previous day"
              onClick={() => goToDay(shiftDay(date, -1))}
            >
              <ChevronLeft size={15} />
            </button>
            {/* Disabled rather than hidden: a control that comes and goes moves
                the two beside it, so the arrow you meant to press again has
                shifted under your finger. Marked active on the day itself, the
                same way the sort pills say which one you're on. */}
            <button
              className={`seg${isToday ? " active" : ""}`}
              disabled={isToday}
              onClick={() => goToDay(todayStr())}
            >
              Today
            </button>
            <button
              className="seg seg-icon"
              title="Next day"
              aria-label="Next day"
              onClick={() => goToDay(shiftDay(date, 1))}
            >
              <ChevronRight size={15} />
            </button>
          </div>
          {/* Its own pill: a reset is not a fourth step through the days. Dead
              on a day that's already as it opens — there's nothing to put
              back, and offering it would suggest there were. */}
          <div className="segmented day-nav-reset">
            <button
              className="seg seg-icon"
              title={
                pristine
                  ? "This day is already as it opens"
                  : "Reset this day to a fresh page"
              }
              aria-label="Reset this day to a fresh page"
              disabled={!sheet || pristine}
              onClick={() => setConfirmReset(true)}
            >
              <RotateCcw size={15} />
            </button>
          </div>
        </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmReset}
        title="Reset this day?"
        message={`${label} goes back to the page it would have opened with — the daily template, and anything being sent forward from the last day you wrote in. What's written here now, along with any sections or banner set for this day alone, is removed, and the day stops being marked as one you've been in.`}
        confirmLabel="Reset"
        onConfirm={() => void resetDay()}
        onCancel={() => setConfirmReset(false)}
      />

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
            <TodayCalendar selected={date} refreshKey={resetNonce} />
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
              onRescope={onRescope}
            />
          </div>,
          bottomSlotEl,
        )}
    </AsOfProvider>
  );
}
