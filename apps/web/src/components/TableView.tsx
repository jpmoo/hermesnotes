import { isComplete, type FieldDef } from "@hermes/shared";
import { ArrowDown, ArrowUp, Palette, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { api, type Block, type BlockType, type Collection, type Member } from "../api.ts";
import { fmtDateTime } from "../lib/format.ts";
import { darkTextOn, oneLineHtml } from "../lib/display.ts";
import { emitBlockChange, useBlockOrigin, useBlockSync } from "../lib/block-events.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { ColorPickerModal } from "./ColorPickerModal.tsx";
import { DateTimePicker } from "./DateTimePicker.tsx";
import { FieldInput } from "./FieldInput.tsx";
import { MentionTextInput } from "./MentionTextInput.tsx";
import { TagEditor } from "./TagEditor.tsx";
import { StatusControl } from "./TypedBlockCard.tsx";

/**
 * Column keys: "title" (always first), "prop:<field key>" for properties drawn
 * from the block types present in the table, and the built-ins "tags",
 * "created", "edited".
 */
type SortDir = "asc" | "desc";
interface SortLevel {
  key: string;
  dir: SortDir;
}

const BUILTINS: { key: string; label: string }[] = [
  { key: "tags", label: "Tags" },
  { key: "created", label: "Created" },
  { key: "edited", label: "Edited" },
];

const DEFAULT_WIDTH: Record<string, number> = { title: 260, tags: 200, created: 160, edited: 160 };
const MIN_WIDTH = 60;

const pretty = (k: string) => {
  const t = k.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Parse a "prop:" column key; datespans split into ".start"/".end" columns. */
function propParts(key: string): { fkey: string; part?: "start" | "end" } | null {
  if (!key.startsWith("prop:")) return null;
  const k = key.slice(5);
  if (k.endsWith(".start")) return { fkey: k.slice(0, -6), part: "start" };
  if (k.endsWith(".end")) return { fkey: k.slice(0, -4), part: "end" };
  return { fkey: k };
}

interface Span {
  start?: string;
  end?: string;
}

/** Sortable value of a member under a column. Empties sort last. */
function valueFor(m: Member, key: string, field: FieldDef | undefined): string {
  if (key === "title") {
    const t = m.properties?.title;
    return (typeof t === "string" && t.trim()) || (m.content ?? "").trim().slice(0, 120);
  }
  if (key === "created") return m.createdAt;
  if (key === "edited") return m.updatedAt;
  const p = propParts(key);
  if (!p) return "";
  const v = m.properties?.[p.fkey];
  if (v == null) return "";
  // datespan: split columns order by their leg; the combined column by start.
  if (field?.type === "datespan" && typeof v === "object")
    return String((v as Span)[p.part ?? "start"] ?? "");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function compareBy(levels: SortLevel[], fieldByKey: Map<string, FieldDef>) {
  return (a: Member, b: Member): number => {
    for (const lv of levels) {
      const f = propParts(lv.key) ? fieldByKey.get(propParts(lv.key)!.fkey) : undefined;
      const va = valueFor(a, lv.key, f).toLowerCase();
      const vb = valueFor(b, lv.key, f).toLowerCase();
      if (va === "" || vb === "") {
        if (va === "" && vb === "") continue;
        return va === "" ? 1 : -1; // empties last regardless of direction
      }
      const na = Number(va);
      const nb = Number(vb);
      let r: number;
      if (lv.key !== "title" && va.trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
        r = na - nb;
      } else {
        r = va.localeCompare(vb);
      }
      if (r !== 0) return lv.dir === "desc" ? -r : r;
    }
    return 0;
  };
}

/** One row: owns its property state and autosaves like a list item. */
function TableRow({
  member,
  type,
  columns,
  fieldByKey,
  rowNumber,
  readonly,
  onRemove,
  onMemberChange,
}: {
  member: Member;
  type: BlockType | undefined;
  columns: string[];
  fieldByKey: Map<string, FieldDef>;
  rowNumber: number | null;
  readonly: boolean;
  onRemove: (blockId: string) => void;
  onMemberChange: (id: string, patch: { properties?: Record<string, unknown> }) => void;
}) {
  const { selectBlock, selectOrOpen } = usePanels();
  const [props, setProps] = useState<Record<string, unknown>>(member.properties ?? {});
  const versionRef = useRef(member.version);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  // Cross-surface sync: info-panel edits show in the row immediately.
  const origin = useBlockOrigin();
  useBlockSync(member.id, origin, (b) => {
    versionRef.current = b.version;
    setProps(b.properties ?? {});
  });

  // A dynamic-smart requery (or outside edit) hands us a fresh member object;
  // adopt it unless the user is mid-edit (pending debounce).
  useEffect(() => {
    if (!timer.current) {
      setProps(member.properties ?? {});
      versionRef.current = member.version;
    }
  }, [member]);

  const isText = !type || type.isText;
  const ownKeys = new Set((type?.propertySchema?.fields ?? []).map((f) => f.key));

  const update = (key: string, value: unknown) => {
    const next = { ...props, [key]: value };
    setProps(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void api
        .patch<Block>(`/blocks/${member.id}`, { properties: next, version: versionRef.current })
        .then((u) => {
          versionRef.current = u.version;
          emitBlockChange(member.id, origin);
        })
        .catch(() => {
          /* keep local; a refresh reconciles */
        });
      onMemberChange(member.id, { properties: next });
    }, 600);
  };

  const cell = (key: string): ReactNode => {
    if (key === "title") {
      return isText ? (
        <span
          className="tv-note li-md"
          onClick={() => selectOrOpen(member.id)}
          dangerouslySetInnerHTML={{
            __html: oneLineHtml(props, member.content) || '<span class="li-empty">Empty note</span>',
          }}
        />
      ) : (
        <MentionTextInput
          className="tv-title"
          value={String(props.title ?? "")}
          placeholder={type?.name}
          onChange={(v) => update("title", v)}
        />
      );
    }
    if (key === "tags") return <TagEditor blockId={member.id} />;
    if (key === "created") return <span className="tv-static">{fmtDateTime(member.createdAt)}</span>;
    if (key === "edited") return <span className="tv-static">{fmtDateTime(member.updatedAt)}</span>;
    const { fkey, part } = propParts(key)!;
    const field = fieldByKey.get(fkey);
    // Blank cell when this block's type doesn't carry the field — editing it
    // would invent properties the type never defined.
    if (!field || !ownKeys.has(fkey)) return null;
    // A datespan leg column edits just that end of the span.
    if (field.type === "datespan" && part) {
      const span = (props[fkey] ?? {}) as Span;
      return (
        <DateTimePicker
          value={span[part] ?? ""}
          onChange={(v) => update(fkey, { ...span, [part]: v })}
          placeholder={
            part === "start" ? field.startLabel?.trim() || "Start" : field.endLabel?.trim() || "End"
          }
        />
      );
    }
    // Status matches the rest of the app: the icon cycles on click, no menu.
    if (field.type === "status") {
      return (
        <StatusControl
          field={field}
          value={props[fkey]}
          onChange={(v) => update(fkey, v)}
          fallbackIconKey={type?.iconKey ?? null}
          fallbackColor={type?.iconColor ?? null}
        />
      );
    }
    return (
      <FieldInput
        field={field}
        value={props[fkey]}
        onChange={(v) => update(fkey, v)}
        blockId={member.id}
        showOverdue={Boolean(
          type?.propertySchema?.status_field && !isComplete(type.propertySchema, props),
        )}
      />
    );
  };

  return (
    <tr
      data-block-id={member.id}
      onPointerDownCapture={() => selectBlock(member.id)}
      // A typed row is made of editable cells, so there was nothing to tap that
      // meant "show me this block" — on a phone, where the info panel is an
      // off-screen drawer, selecting a row looked like nothing happened. A tap
      // that isn't aimed at a control now opens it, the way a card or chip does.
      // (On a desktop this is the same selection the capture above already made.)
      onClick={(e) => {
        const el = e.target as HTMLElement;
        if (el.closest("input, textarea, select, button, a, [contenteditable='true'], .dtp, .mention-chip")) {
          return;
        }
        selectOrOpen(member.id);
      }}
    >
      {rowNumber !== null && <td className="tv-num">{rowNumber}</td>}
      {columns.map((key) => (
        <td key={key} className={key === "tags" ? "tv-cell tv-cell-tags" : "tv-cell"}>
          {cell(key)}
        </td>
      ))}
      <td className="tv-remove-cell">
        {!readonly && (
          <button className="icon-btn tv-remove" title="Remove from table" onClick={() => onRemove(member.id)}>
            <X size={13} />
          </button>
        )}
      </td>
    </tr>
  );
}

export function TableView({
  collection,
  members,
  types,
  onChanged,
  onMemberChange,
}: {
  collection: Collection;
  members: Member[];
  types: BlockType[];
  onChanged: () => void;
  onMemberChange: (id: string, patch: { properties?: Record<string, unknown> }) => void;
}) {
  const cid = collection.id;
  const props = collection.properties;
  const { bottomSlotEl, selectedBlockId } = usePanels();
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  // ── Persisted view settings (local state, patched to the collection) ──
  // "title" is an ordinary entry in the order (it just renders specially).
  // Legacy shapes stored it implicitly-first with a separate hide flag — fold
  // that into the array on load.
  const [columns, setColumns] = useState<string[]>(() => {
    const stored = Array.isArray(props.table_columns) ? (props.table_columns as string[]) : [];
    if (!stored.includes("title") && props.table_hide_title !== true) return ["title", ...stored];
    return stored;
  });
  const [sort, setSort] = useState<SortLevel[]>(() =>
    Array.isArray(props.table_sort) ? (props.table_sort as SortLevel[]) : [],
  );
  const [widths, setWidths] = useState<Record<string, number>>(
    () => (props.table_col_widths as Record<string, number>) ?? {},
  );
  const [rowNumbers, setRowNumbers] = useState(props.table_row_numbers !== false);
  const [wrap, setWrap] = useState(props.table_wrap === true);
  const [headerColor, setHeaderColor] = useState<string | null>(
    typeof props.table_header_color === "string" ? props.table_header_color : null,
  );
  const persist = (patch: Record<string, unknown>) => void api.patch(`/collections/${cid}`, patch);

  const isDynamic = props.membership_mode === "smart" && (props.smart_mode ?? "dynamic") === "dynamic";

  // ── Columns available from the block types present in the table ──
  const fieldByKey = useMemo(() => {
    const map = new Map<string, FieldDef>();
    const present = new Set(members.map((m) => m.blockTypeId));
    for (const t of types) {
      if (!present.has(t.id) || t.isText || !t.propertySchema) continue;
      for (const f of t.propertySchema.fields) {
        if (f.key !== "title" && !map.has(f.key)) map.set(f.key, f);
      }
    }
    return map;
  }, [members, types]);

  const labelOf = (key: string): string => {
    if (key === "title") return "Title";
    const b = BUILTINS.find((x) => x.key === key);
    if (b) return b.label;
    const p = propParts(key);
    if (!p) return key;
    const f = fieldByKey.get(p.fkey);
    const base = f?.label?.trim() || pretty(p.fkey);
    if (p.part === "start") return `${base} · ${f?.startLabel?.trim() || "Start"}`;
    if (p.part === "end") return `${base} · ${f?.endLabel?.trim() || "End"}`;
    return base;
  };

  const shown = columns;
  // Persist the order plus the legacy flag, so the load-time normalization
  // above can't resurrect a deliberately removed title column.
  const saveColumns = (next: string[]) => {
    setColumns(next);
    persist({ table_columns: next, table_hide_title: !next.includes("title") });
  };
  const available = [
    ...(columns.includes("title") ? [] : [{ key: "title", label: "Title" }]),
    ...[...fieldByKey.entries()].flatMap(([k, f]) => {
      if (f.type === "attachments") return [];
      const base = f.label?.trim() || pretty(k);
      const out: { key: string; label: string }[] = [];
      if (!columns.includes(`prop:${k}`)) out.push({ key: `prop:${k}`, label: base });
      // Datespans also split into one column per leg, labeled with the
      // field's own start/end labels.
      if (f.type === "datespan") {
        if (!columns.includes(`prop:${k}.start`))
          out.push({ key: `prop:${k}.start`, label: `${base} · ${f.startLabel?.trim() || "Start"}` });
        if (!columns.includes(`prop:${k}.end`))
          out.push({ key: `prop:${k}.end`, label: `${base} · ${f.endLabel?.trim() || "End"}` });
      }
      return out;
    }),
    ...BUILTINS.filter((b) => !columns.includes(b.key)),
  ];

  const addColumn = (key: string) => saveColumns([...columns, key]);
  const removeColumn = (key: string) => {
    saveColumns(columns.filter((k) => k !== key));
    if (sort.some((s) => s.key === key)) {
      const ns = sort.filter((s) => s.key !== key);
      setSort(ns);
      persist({ table_sort: ns });
    }
  };
  const moveColumn = (key: string, delta: -1 | 1) => {
    const i = columns.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= columns.length) return;
    const next = [...columns];
    [next[i], next[j]] = [next[j]!, next[i]!];
    saveColumns(next);
  };

  // ── Excel-style sorting: each newly sorted column appends a level ──
  const setLevel = (key: string, dir: SortDir) => {
    const i = sort.findIndex((s) => s.key === key);
    const next =
      i >= 0
        ? sort.map((s, idx) => (idx === i ? { ...s, dir } : s))
        : [...sort, { key, dir }];
    setSort(next);
    persist({ table_sort: next });
  };
  const clearLevel = (key: string) => {
    const next = sort.filter((s) => s.key !== key);
    setSort(next);
    persist({ table_sort: next });
  };
  const clearSort = () => {
    setSort([]);
    persist({ table_sort: [] });
  };

  const sorted = useMemo(
    () => (sort.length === 0 ? members : [...members].sort(compareBy(sort, fieldByKey))),
    [members, sort, fieldByKey],
  );

  // ── Header context menu (right-click, Excel-style) ──
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  // ── Column resize (drag the header's right border) ──
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const widthTimer = useRef<ReturnType<typeof setTimeout>>();
  const widthOf = (key: string) => widths[key] ?? DEFAULT_WIDTH[key] ?? 160;
  const startResize = (key: string, e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = { key, startX: e.clientX, startW: widthOf(key) };
    const move = (ev: PointerEvent) => {
      const r = resizing.current;
      if (!r) return;
      const w = Math.max(MIN_WIDTH, r.startW + (ev.clientX - r.startX));
      setWidths((prev) => {
        const next = { ...prev, [r.key]: w };
        if (widthTimer.current) clearTimeout(widthTimer.current);
        widthTimer.current = setTimeout(() => persist({ table_col_widths: next }), 500);
        return next;
      });
    };
    const up = () => {
      resizing.current = null;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  const onRemove = async (blockId: string) => {
    await api.del(`/collections/${cid}/members/${blockId}`);
    onChanged();
  };
  const [colorOpen, setColorOpen] = useState(false);
  const headerBg = headerColor ?? "var(--surface-2)";
  const headerFg = headerColor ? (darkTextOn(headerColor) ? "#26282b" : "#ffffff") : undefined;
  const sortIndex = (key: string) => sort.findIndex((s) => s.key === key);

  return (
    <>
      <div className={`tv-scroll${wrap ? " tv-wrap" : " tv-truncate"}`}>
        <table className="tv-table">
          <colgroup>
            {rowNumbers && <col style={{ width: 44 }} />}
            {shown.map((key) => (
              <col key={key} style={{ width: widthOf(key) }} />
            ))}
            <col style={{ width: 36 }} />
          </colgroup>
          <thead>
            <tr style={{ background: headerBg, color: headerFg }}>
              {rowNumbers && <th className="tv-num">#</th>}
              {shown.map((key) => {
                const si = sortIndex(key);
                return (
                  <th
                    key={key}
                    title="Right-click to sort"
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ key, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="tv-th">
                      <span className="tv-th-label">{labelOf(key)}</span>
                      {si >= 0 && (
                        <span className="tv-sort-badge" title={`sort level ${si + 1}`}>
                          {sort[si]!.dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                          {sort.length > 1 && <span>{si + 1}</span>}
                        </span>
                      )}
                    </span>
                    <span className="tv-resizer" onPointerDown={(e) => startResize(key, e)} />
                  </th>
                );
              })}
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((m, i) => (
              <TableRow
                key={m.id}
                member={m}
                type={m.blockTypeId ? typeById.get(m.blockTypeId) : undefined}
                columns={shown}
                fieldByKey={fieldByKey}
                rowNumber={rowNumbers ? i + 1 : null}
                readonly={isDynamic}
                onRemove={onRemove}
                onMemberChange={onMemberChange}
              />
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="hint" style={{ padding: 12 }}>Empty table. Add a row.</div>}
      </div>

      {menu && (
        <div
          className="menu tv-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu.key === "tags" ? (
            <div className="hint" style={{ padding: "6px 10px" }}>Tags can’t be sorted</div>
          ) : (
            <>
              <button className="menu-item" onClick={() => { setLevel(menu.key, "asc"); setMenu(null); }}>
                Sort A → Z
              </button>
              <button className="menu-item" onClick={() => { setLevel(menu.key, "desc"); setMenu(null); }}>
                Sort Z → A
              </button>
              {sortIndex(menu.key) >= 0 && (
                <button className="menu-item" onClick={() => { clearLevel(menu.key); setMenu(null); }}>
                  Don’t sort by this column
                </button>
              )}
            </>
          )}
          {sort.length > 0 && (
            <button className="menu-item" onClick={() => { clearSort(); setMenu(null); }}>
              Clear all sorting
            </button>
          )}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => { removeColumn(menu.key); setMenu(null); }}>
            Remove column
          </button>
        </div>
      )}

      {/* Right-panel table tools (below the smart query when both are present). */}
      {bottomSlotEl &&
        selectedBlockId === cid &&
        createPortal(
          <>
            <div className="panel-divider" />
            <div className="panel-h">Table</div>

            <div className="field">
              <span className="field-label">Columns</span>
              {columns.length === 0 && <div className="hint">No columns yet — add some below.</div>}
              {columns.map((key, i) => (
                <div className="tv-col-row" key={key}>
                  <span className="tv-col-name">{labelOf(key)}</span>
                  <button
                    className="icon-btn"
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => moveColumn(key, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Move down"
                    disabled={i === columns.length - 1}
                    onClick={() => moveColumn(key, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button className="icon-btn" title="Remove" onClick={() => removeColumn(key)}>
                    <X size={13} />
                  </button>
                </div>
              ))}
              {available.length > 0 && (
                <select
                  value=""
                  onChange={(e) => e.target.value && addColumn(e.target.value)}
                  style={{ marginTop: 6 }}
                >
                  <option value="">+ Add column…</option>
                  {available.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="field">
              <span className="field-label">Header row</span>
              <button className="ghost tv-color-btn" onClick={() => setColorOpen(true)}>
                <Palette size={14} />
                <span className="tv-swatch" style={{ background: headerColor ?? "var(--surface-2)" }} />
                {headerColor ?? "Default"}
              </button>
            </div>

            <div className="field">
              <span className="field-label">Rows</span>
              <div className="segmented">
                <button
                  className={`seg${rowNumbers ? " active" : ""}`}
                  onClick={() => { setRowNumbers(true); persist({ table_row_numbers: true }); }}
                >
                  Numbered
                </button>
                <button
                  className={`seg${!rowNumbers ? " active" : ""}`}
                  onClick={() => { setRowNumbers(false); persist({ table_row_numbers: false }); }}
                >
                  Plain
                </button>
              </div>
            </div>

            <div className="field">
              <span className="field-label">Cells</span>
              <div className="segmented">
                <button
                  className={`seg${wrap ? " active" : ""}`}
                  onClick={() => { setWrap(true); persist({ table_wrap: true }); }}
                >
                  Wrap
                </button>
                <button
                  className={`seg${!wrap ? " active" : ""}`}
                  onClick={() => { setWrap(false); persist({ table_wrap: false }); }}
                >
                  Truncate
                </button>
              </div>
            </div>
          </>,
          bottomSlotEl,
        )}

      <ColorPickerModal
        open={colorOpen}
        title="Header row color"
        value={headerColor ?? "#eef4f6"}
        onCancel={() => setColorOpen(false)}
        onSave={(c) => {
          setHeaderColor(c);
          persist({ table_header_color: c });
          setColorOpen(false);
        }}
      />
    </>
  );
}
