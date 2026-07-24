import type { FieldDef, PropertySchema } from "@hermes/shared";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Block, type BlockType, type Collection, type Member } from "../api.ts";
import { isOverdue, oneLineText } from "../lib/display.ts";
import { normalizeFilter } from "../lib/filter.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/**
 * Calendar collection: a month / week / 3-day date view. Smart-query fed —
 * matching cards land on the days their date/datespan fields point to (same
 * placement logic as a matrix in date mode). Dates are read-only here; you
 * reschedule by editing the card. The status chip stays interactive.
 */

type ViewMode = "month" | "week" | "day3";
const VIEWS: { key: ViewMode; label: string }[] = [
  { key: "month", label: "Month" },
  { key: "week", label: "Week" },
  { key: "day3", label: "3-day" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pretty = (v: string) => v.replace(/_/g, " ");
const fmtShort = (v: string) => {
  const d = new Date(v.includes("T") ? v : `${v}T00:00`);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

interface DateBit {
  text: string;
  overdue: boolean;
}

/** Every day (YYYY-MM-DD) a block's date/datespan fields land on. */
function occupiedDays(schema: PropertySchema | null | undefined, props: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const f of schema?.fields ?? []) {
    const v = props[f.key];
    if (v == null || v === "") continue;
    if (f.type === "datetime" || f.type === "date") {
      out.add(String(v).slice(0, 10));
    } else if (f.type === "datespan" && typeof v === "object") {
      const span = v as { start?: string; end?: string };
      const s = span.start?.slice(0, 10) || "";
      const e = span.end?.slice(0, 10) || "";
      if (s && e && e >= s) {
        const d = new Date(`${s}T00:00`);
        for (let i = 0; i < 366; i++) {
          const k = ymd(d);
          out.add(k);
          if (k === e) break;
          d.setDate(d.getDate() + 1);
        }
      } else if (s || e) out.add(s || e);
    }
  }
  return out;
}

/** Short display strings for any dated fields (with overdue flagging). */
function dateBits(schema: PropertySchema | null | undefined, props: Record<string, unknown>): DateBit[] {
  const statusKey = schema?.status_field;
  const done = statusKey ? (schema?.complete_values ?? []).includes(String(props[statusKey] ?? "")) : false;
  const out: DateBit[] = [];
  for (const f of schema?.fields ?? []) {
    const v = props[f.key];
    if (v == null || v === "") continue;
    if (f.type === "datetime" || f.type === "date") {
      out.push({ text: fmtShort(String(v)), overdue: false });
    } else if (f.type === "datespan" && typeof v === "object") {
      const span = v as { start?: string; end?: string };
      const s = span.start ? fmtShort(span.start) : "";
      const e = span.end ? fmtShort(span.end) : "";
      if (s || e) out.push({ text: s && e ? `${s} – ${e}` : s || e, overdue: !done && isOverdue(span.end) });
    }
  }
  return out;
}

function statusFieldOf(type: BlockType | undefined): FieldDef | null {
  const schema = type?.propertySchema;
  const key = schema?.status_field;
  return schema?.fields.find((f) => f.type === "status" && f.key === key) ?? null;
}

interface Item {
  id: string;
  blockTypeId: string | null;
  label: string;
  props: Record<string, unknown>;
  version: number;
}

function Chip({
  item,
  types,
  onStatus,
}: {
  item: Item;
  types: BlockType[];
  onStatus: (item: Item, field: FieldDef, next: string) => void;
}) {
  const { selectBlock } = usePanels();
  const t = item.blockTypeId ? types.find((x) => x.id === item.blockTypeId) : undefined;
  const statusField = statusFieldOf(t);
  const status = statusField ? String(item.props[statusField.key] ?? "") : "";
  const dates = dateBits(t?.propertySchema ?? null, item.props);
  const cycle = () => {
    if (!statusField) return;
    const opts = statusField.options ?? [];
    if (!opts.length) return;
    const next = opts[(opts.indexOf(status) + 1) % opts.length];
    if (next) onStatus(item, statusField, next);
  };
  return (
    <div
      className="cal-chip"
      onClick={(e) => {
        e.stopPropagation();
        selectBlock(item.id);
      }}
    >
      {statusField ? (
        <button
          className="chip-status"
          title={status ? `Status: ${pretty(status)} — click to cycle` : "Set status"}
          onClick={(e) => {
            e.stopPropagation();
            cycle();
          }}
        >
          <BlockIcon
            iconKey={statusField.optionIcons?.[status] ?? t?.iconKey}
            color={statusField.optionColors?.[status] ?? t?.iconColor}
            size={13}
          />
        </button>
      ) : (
        <BlockIcon iconKey={!t || t.isText ? "type" : t.iconKey} color={t && !t.isText ? t.iconColor : null} size={12} />
      )}
      <span className="cal-chip-label">{item.label}</span>
      {dates.some((d) => d.overdue) && <span className="cal-chip-overdue" title="Overdue" />}
    </div>
  );
}

export function CalendarView({
  collection,
  members,
  types,
  onChanged,
}: {
  collection: Collection;
  members: Member[];
  types: BlockType[];
  onChanged: () => void;
}) {
  const { selectBlock } = usePanels();
  const selectCollection = () => selectBlock(collection.id, { collection: true });
  const props = collection.properties;
  const isSmart = props.membership_mode === "smart";

  const [view, setView] = useState<ViewMode>(
    ((): ViewMode => {
      const v = props.calendar_view;
      return v === "week" || v === "day3" ? v : "month";
    })(),
  );
  useEffect(() => {
    const v = collection.properties.calendar_view;
    setView(v === "week" || v === "day3" ? v : "month");
  }, [collection.properties.calendar_view]);

  // Anchor date (today by default); prev/next steps by view size.
  const [anchor, setAnchor] = useState(() => ymd(new Date()));
  const [matches, setMatches] = useState<Block[]>([]);
  const [queryTick, setQueryTick] = useState(0);

  useEffect(() => {
    if (!isSmart) {
      setMatches([]);
      return;
    }
    let alive = true;
    void api
      .post<Block[]>("/blocks/query", { filterQuery: normalizeFilter(props.filter_query) })
      .then((r) => alive && setMatches(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSmart, JSON.stringify(props.filter_query), collection.updatedAt, queryTick]);

  const setViewMode = (v: ViewMode) => {
    setView(v);
    selectCollection();
    void api.patch(`/collections/${collection.id}`, { calendar_view: v }).then(onChanged);
  };

  const today = ymd(new Date());
  const anchorDate = new Date(`${anchor}T00:00`);

  // Visible days for the current view.
  const days = useMemo<string[]>(() => {
    if (view === "day3") return [-1, 0, 1].map((n) => ymd(addDays(anchorDate, n)));
    if (view === "week") {
      const start = addDays(anchorDate, -anchorDate.getDay());
      return Array.from({ length: 7 }, (_, i) => ymd(addDays(start, i)));
    }
    // month: full weeks covering the anchor's month
    const first = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
    const gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => ymd(addDays(gridStart, i)));
  }, [view, anchor]);

  // Source blocks: smart → live query matches; else the explicit members.
  const source = useMemo<Item[]>(() => {
    const toItem = (b: { id: string; blockTypeId: string | null; properties: unknown; content?: string | null; version: number }): Item => ({
      id: b.id,
      blockTypeId: b.blockTypeId,
      label: oneLineText(b.properties as Record<string, unknown>, b.content) || "Untitled",
      props: (b.properties ?? {}) as Record<string, unknown>,
      version: b.version,
    });
    return (isSmart ? matches : members).map(toItem);
  }, [isSmart, matches, members]);

  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  // Day → items landing on it.
  const byDay = useMemo(() => {
    const visible = new Set(days);
    const map = new Map<string, Item[]>();
    for (const it of source) {
      const schema = it.blockTypeId ? typeById.get(it.blockTypeId)?.propertySchema ?? null : null;
      for (const d of occupiedDays(schema, it.props)) {
        if (!visible.has(d)) continue;
        map.set(d, [...(map.get(d) ?? []), it]);
      }
    }
    return map;
  }, [source, days, typeById]);

  const patchStatus = (item: Item, field: FieldDef, next: string) => {
    const nextProps = { ...item.props, [field.key]: next };
    void api
      .patch(`/blocks/${item.id}`, { properties: nextProps, version: item.version })
      .catch(() => {})
      .then(() => {
        setMatches((ms) =>
          ms.map((b) => (b.id === item.id ? { ...b, properties: nextProps, version: (b.version ?? 0) + 1 } : b)),
        );
        setQueryTick((t) => t + 1);
        onChanged();
      });
  };
  const onStatus = (item: Item, field: FieldDef, next: string) => patchStatus(item, field, next);

  const step = (dir: -1 | 1) => {
    if (view === "day3") setAnchor(ymd(addDays(anchorDate, dir * 3)));
    else if (view === "week") setAnchor(ymd(addDays(anchorDate, dir * 7)));
    else setAnchor(ymd(new Date(anchorDate.getFullYear(), anchorDate.getMonth() + dir, 1)));
  };

  const rangeLabel =
    view === "month"
      ? `${MONTHS[anchorDate.getMonth()]} ${anchorDate.getFullYear()}`
      : `${fmtShort(days[0]!)} – ${fmtShort(days[days.length - 1]!)}, ${anchorDate.getFullYear()}`;

  const cols = view === "day3" ? 3 : 7;
  const dayCell = (d: string) => {
    const items = byDay.get(d) ?? [];
    const dd = new Date(`${d}T00:00`);
    return (
      <div key={d} className={`cal-cell${d === today ? " today" : ""}${d === anchor && view !== "month" ? " anchor" : ""}`}>
        <div className="cal-cell-head">
          {view === "month" ? (
            <span className="cal-daynum">{dd.getDate()}</span>
          ) : (
            <>
              <span className="cal-dow">{WEEKDAYS[dd.getDay()]}</span>
              <span className="cal-daynum">{dd.getDate()}</span>
            </>
          )}
        </div>
        <div className="cal-cell-body">
          {items.map((it) => (
            <Chip key={it.id} item={it} types={types} onStatus={onStatus} />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="cal-wrap" onClick={selectCollection}>
      <div className="cal-toolbar">
        <span className="segmented">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={`seg${view === v.key ? " active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setViewMode(v.key);
              }}
            >
              {v.label}
            </button>
          ))}
        </span>
        <span className="cal-nav">
          <button className="icon-btn" title="Previous" onClick={(e) => { e.stopPropagation(); step(-1); }}>
            <ChevronLeft size={16} />
          </button>
          <button className="ghost cal-today-btn" onClick={(e) => { e.stopPropagation(); setAnchor(today); }}>
            Today
          </button>
          <button className="icon-btn" title="Next" onClick={(e) => { e.stopPropagation(); step(1); }}>
            <ChevronRight size={16} />
          </button>
        </span>
        <span className="cal-range">{rangeLabel}</span>
        {!isSmart && <span className="hint">Calendars are query-fed — give this collection a query.</span>}
      </div>

      {view !== "day3" && (
        <div className="cal-dow-row" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {WEEKDAYS.map((w) => (
            <span key={w} className="cal-dow-cell">{w}</span>
          ))}
        </div>
      )}
      <div
        className={`cal-grid cal-${view}`}
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {days.map(dayCell)}
      </div>
    </div>
  );
}
