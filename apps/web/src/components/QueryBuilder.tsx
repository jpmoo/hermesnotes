import { DAILY_NOTE_TYPE_ID, optionLabel, type Condition, type FieldDef, type FilterGroup, type PropertyOp } from "@hermes/shared";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Block, type BlockRef, type BlockType } from "../api.ts";

/** Synthetic "type" so a query can target Daily Notes (which have no real block
 *  type). Selecting it matches today_note blocks and lifts the hide filter. */
const DAILY_NOTE_TYPE: BlockType = {
  id: DAILY_NOTE_TYPE_ID,
  name: "Daily Note",
  iconKey: "calendar-days",
  iconColor: null,
  iconSource: "lucide",
  showIcon: true,
  propertySchema: {
    fields: [{ key: "today_note", label: "Date", type: "date", order: 0, includeEmbed: false }],
  },
  schemaVersion: 0,
  isText: true,
  builtin: true,
};
import { oneLineText } from "../lib/display.ts";
import { emptyGroup } from "../lib/filter.ts";
import { BlockIcon } from "../lib/icons.tsx";

type Item = Condition | FilterGroup;
type Kind = Condition["kind"];

const KIND_LABELS: Record<Kind, string> = {
  blockType: "Block type",
  created: "Created",
  edited: "Edited",
  tag: "Tag",
  property: "Field",
  text: "Text",
  semantic: "Semantic",
  hasAttachment: "Attachment",
};

const PROP_OPS: PropertyOp[] = ["eq", "neq", "contains", "lt", "gt", "empty", "notEmpty"];
// Reference fields hold arrays of block ids: only membership-style ops apply.
const REF_OPS: PropertyOp[] = ["contains", "empty", "notEmpty"];
const OP_LABEL: Record<PropertyOp, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  lt: "<",
  gt: ">",
  empty: "is empty",
  notEmpty: "is not empty",
};

function defaultCondition(kind: Kind, types: BlockType[], fields: FieldDef[]): Condition {
  switch (kind) {
    case "blockType":
      return { kind, typeId: types.find((t) => !t.isText)?.id ?? types[0]?.id ?? "" };
    case "created":
    case "edited":
      return { kind, op: "after", date: "" };
    case "tag":
      return { kind, tag: "", op: "include" };
    case "property":
      return { kind, key: fields[0]?.key ?? "", op: "eq", value: "" };
    case "text":
      return { kind, value: "" };
    case "semantic":
      return { kind, value: "", floor: 0.75 };
    case "hasAttachment":
      return { kind, has: true };
  }
}

const EMPTY_TYPES: Set<string> = new Set();

/** Collect all block-type ids referenced anywhere in the tree. */
function collectTypeIds(g: FilterGroup, out: Set<string>): void {
  for (const it of g.items) {
    if (it.kind === "group") collectTypeIds(it, out);
    else if (it.kind === "blockType" && it.typeId) out.add(it.typeId);
  }
}

/**
 * Reference-field value: a dynamic search over the field's target type.
 * Stores the picked block's id (what the property actually contains) while
 * showing its label. Dropdown is position:fixed so panels can't clip it.
 */
function RefValueInput({
  refTypeId,
  value,
  onChange,
}: {
  refTypeId?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<BlockRef[]>([]);
  const [label, setLabel] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [refType, setRefType] = useState<BlockType | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // The target type's icon labels both the results and the picked chip.
  useEffect(() => {
    if (!refTypeId) return;
    void api
      .get<BlockType[]>("/block-types")
      .then((ts) => setRefType(ts.find((t) => t.id === refTypeId) ?? null))
      .catch(() => {});
  }, [refTypeId]);

  useEffect(() => {
    if (!value) {
      setLabel(null);
      return;
    }
    void api
      .get<Block>(`/blocks/${value}`)
      .then((b) => setLabel(oneLineText(b.properties, b.content) || "Untitled"))
      .catch(() => setLabel("(unknown)"));
  }, [value]);

  useEffect(() => {
    if (!open || !refTypeId) return;
    const t = setTimeout(() => {
      void api
        .get<BlockRef[]>(
          `/blocks/references?typeId=${encodeURIComponent(refTypeId)}&q=${encodeURIComponent(q)}`,
        )
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, refTypeId]);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 220) });
    };
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest(".qb-ref-menu")) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!refTypeId) return <span className="hint">no target type</span>;
  return (
    <div className="ref-combo" ref={ref}>
      {value && !open ? (
        <button className="ghost qb-ref-chip" type="button" onClick={() => setOpen(true)}>
          <BlockIcon iconKey={refType?.iconKey} color={refType?.iconColor} size={13} />
          <span className="qb-ref-chip-label">{label ?? "…"}</span>
        </button>
      ) : (
        <input
          placeholder="Search…"
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => setQ(e.target.value)}
        />
      )}
      {open &&
        pos &&
        createPortal(
          <div
            className="menu qb-ref-menu"
            style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, right: "auto" }}
          >
            {results.map((r) => (
              <button
                key={r.id}
                className="menu-item type-item"
                type="button"
                onClick={() => {
                  onChange(r.id);
                  setOpen(false);
                  setQ("");
                }}
              >
                <BlockIcon iconKey={refType?.iconKey} color={refType?.iconColor} size={14} />
                <span>{r.label}</span>
              </button>
            ))}
            {results.length === 0 && (
              <div className="hint" style={{ padding: "6px 10px" }}>
                No matches.
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Value input matched to the selected field's type. */
function ValueInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = field?.type;
  if (t === "date" || t === "datetime")
    return (
      <input
        type="text"
        list="hn-dates"
        placeholder="YYYY-MM-DD or today+1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  if (t === "number")
    return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (t === "boolean")
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  if (t === "reference")
    return <RefValueInput refTypeId={field?.refTypeId} value={value} onChange={onChange} />;
  if ((t === "status" || t === "select") && field?.options?.length)
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {optionLabel(field, o)}
          </option>
        ))}
      </select>
    );
  return <input placeholder="value" value={value} onChange={(e) => onChange(e.target.value)} />;
}

function ConditionRow({
  c,
  types,
  tags,
  fields,
  onChange,
  onRemove,
}: {
  c: Condition;
  types: BlockType[];
  tags: string[];
  fields: FieldDef[];
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  return (
    <div className="cond-row">
      <span className="cond-kind">{KIND_LABELS[c.kind]}</span>

      {c.kind === "blockType" && (
        <>
          <select
            value={c.op ?? "is"}
            onChange={(e) => onChange({ ...c, op: e.target.value as "is" | "isNot" })}
          >
            <option value="is">is</option>
            <option value="isNot">is not</option>
          </select>
          <select value={c.typeId} onChange={(e) => onChange({ ...c, typeId: e.target.value })}>
            {types.map((t) => (
              <option key={t.id} value={t.id} style={{ textTransform: "capitalize" }}>
                {t.name}
              </option>
            ))}
          </select>
        </>
      )}

      {(c.kind === "created" || c.kind === "edited") && (
        <>
          <select value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as "before" | "after" })}>
            <option value="after">after</option>
            <option value="before">before</option>
          </select>
          <input
            type="text"
            list="hn-dates"
            placeholder="YYYY-MM-DD or today-7"
            value={c.date}
            onChange={(e) => onChange({ ...c, date: e.target.value })}
          />
        </>
      )}

      {c.kind === "tag" && (
        <>
          <select
            value={c.op ?? "include"}
            onChange={(e) => onChange({ ...c, op: e.target.value as "include" | "exclude" })}
          >
            <option value="include">includes</option>
            <option value="exclude">excludes</option>
          </select>
          <input
            type="text"
            list="hn-tags"
            placeholder="tag"
            value={c.tag}
            onChange={(e) => onChange({ ...c, tag: e.target.value })}
          />
        </>
      )}

      {c.kind === "property" && (
        <>
          <select
            value={c.key}
            onChange={(e) => {
              const key = e.target.value;
              const nf = fields.find((f) => f.key === key);
              const op =
                nf?.type === "reference" && !REF_OPS.includes(c.op) ? "contains" : c.op;
              onChange({ ...c, key, op, value: "" });
            }}
          >
            {/* A key the group no longer offers — a saved query written before
                the types changed, or under a different match mode — stays
                listed, so opening the panel can't quietly rewrite it. */}
            {c.key && !fields.some((f) => f.key === c.key) && (
              <option value={c.key}>{c.key.replace(/_/g, " ")} (not shared)</option>
            )}
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label?.trim() || f.key.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as PropertyOp })}>
            {(() => {
              const ft = fields.find((f) => f.key === c.key)?.type;
              const isRef = ft === "reference";
              const isDate = ft === "date" || ft === "datetime";
              // Date fields read like the Created/Edited conditions: before/after.
              const label = (op: PropertyOp) =>
                isRef && op === "contains"
                  ? "includes"
                  : isDate && op === "lt"
                    ? "before"
                    : isDate && op === "gt"
                      ? "after"
                      : OP_LABEL[op];
              return (isRef ? REF_OPS : PROP_OPS).map((op) => (
                <option key={op} value={op}>
                  {label(op)}
                </option>
              ));
            })()}
          </select>
          {c.op !== "empty" && c.op !== "notEmpty" && (
            <ValueInput
              field={fields.find((f) => f.key === c.key)}
              value={c.value ?? ""}
              onChange={(v) => onChange({ ...c, value: v })}
            />
          )}
        </>
      )}

      {c.kind === "text" && (
        <input placeholder="keyword" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} />
      )}

      {c.kind === "hasAttachment" && (
        <select
          value={c.has ? "yes" : "no"}
          onChange={(e) => onChange({ ...c, has: e.target.value === "yes" })}
        >
          <option value="yes">has attachment</option>
          <option value="no">no attachment</option>
        </select>
      )}

      {c.kind === "semantic" && (
        <>
          <input placeholder="meaning…" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} />
          <span className="cond-floor">
            ≥ {c.floor.toFixed(2)}
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={c.floor}
              onChange={(e) => onChange({ ...c, floor: Number(e.target.value) })}
            />
          </span>
        </>
      )}

      <button className="icon-btn cond-remove" title="Remove" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

function GroupEditor({
  group,
  onChange,
  onRemove,
  types,
  tags,
  fieldsFor,
  inheritedTypes,
  isRoot,
}: {
  group: FilterGroup;
  onChange: (g: FilterGroup) => void;
  onRemove?: () => void;
  types: BlockType[];
  tags: string[];
  /** What this group may filter on, given the types in play and how it matches. */
  fieldsFor: (typeIds: Set<string>, match: FilterGroup["match"]) => FieldDef[];
  /** The enclosing group's types, for a group that names none of its own. */
  inheritedTypes: Set<string>;
  isRoot: boolean;
}) {
  // The types this group is talking about: those named anywhere inside it, or —
  // when it names none — whatever the group around it was working with.
  const localTypes = useMemo(() => {
    const s = new Set<string>();
    collectTypeIds(group, s);
    return s.size ? s : inheritedTypes;
  }, [group, inheritedTypes]);
  const fields = fieldsFor(localTypes, group.match);
  const [menuOpen, setMenuOpen] = useState(false);
  // Open upward by default (fits the modal); flip downward when the button sits
  // near the viewport top (e.g. the right panel), where an upward menu would be
  // clipped by the panel's scroll container.
  const [openUp, setOpenUp] = useState(true);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const setItem = (i: number, it: Item) =>
    onChange({ ...group, items: group.items.map((x, idx) => (idx === i ? it : x)) });
  const removeItem = (i: number) =>
    onChange({ ...group, items: group.items.filter((_, idx) => idx !== i) });
  const addCondition = (kind: Kind) => {
    onChange({ ...group, items: [...group.items, defaultCondition(kind, types, fields)] });
    setMenuOpen(false);
  };
  const addGroup = () => {
    onChange({ ...group, items: [...group.items, emptyGroup()] });
    setMenuOpen(false);
  };

  return (
    <div className={`filter-group${isRoot ? " root" : ""}`}>
      <div className="group-head">
        <span className="hint">Match</span>
        <div className="segmented">
          {(["all", "any"] as const).map((m) => (
            <button
              key={m}
              className={`seg${group.match === m ? " active" : ""}`}
              onClick={() => onChange({ ...group, match: m })}
            >
              {m}
            </button>
          ))}
        </div>
        <span className="hint">of:</span>
        {!isRoot && onRemove && (
          <button className="icon-btn cond-remove" title="Remove group" onClick={onRemove}>
            ✕
          </button>
        )}
      </div>

      {group.items.map((it, i) =>
        it.kind === "group" ? (
          <GroupEditor
            key={i}
            group={it}
            onChange={(g) => setItem(i, g)}
            onRemove={() => removeItem(i)}
            types={types}
            tags={tags}
            fieldsFor={fieldsFor}
            inheritedTypes={localTypes}
            isRoot={false}
          />
        ) : (
          <ConditionRow
            key={i}
            c={it}
            types={types}
            tags={tags}
            fields={fields}
            onChange={(nc) => setItem(i, nc)}
            onRemove={() => removeItem(i)}
          />
        ),
      )}

      <div className="nav-kebab" ref={menuRef} style={{ position: "relative", marginTop: 8 }}>
        <button
          className="ghost"
          onClick={() => {
            if (!menuOpen && menuRef.current) {
              // ~9 items ≈ 340px; flip down when there isn't room above.
              setOpenUp(menuRef.current.getBoundingClientRect().top > 360);
            }
            setMenuOpen((o) => !o);
          }}
        >
          + Add
        </button>
        {menuOpen && (
          <div
            className="menu"
            style={
              openUp
                ? { left: 0, right: "auto", top: "auto", bottom: "calc(100% + 4px)" }
                : { left: 0, right: "auto", top: "calc(100% + 4px)", bottom: "auto" }
            }
          >
            {(Object.keys(KIND_LABELS) as Kind[]).map((k) => {
              const disabled = k === "property" && fields.length === 0;
              return (
                <button
                  key={k}
                  className="menu-item"
                  disabled={disabled}
                  title={disabled ? "Add a Block type condition first" : undefined}
                  onClick={() => !disabled && addCondition(k)}
                >
                  {KIND_LABELS[k]}
                </button>
              );
            })}
            <div className="menu-sep" />
            <button className="menu-item" onClick={addGroup}>
              Nested group
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function QueryBuilder({
  value,
  onChange,
  types,
  tags,
  archived = false,
}: {
  value: FilterGroup;
  onChange: (v: FilterGroup) => void;
  types: BlockType[];
  tags: string[];
  /** Count against archived blocks instead of live ones — the Archive's filter
   *  is describing that side, and a count of the other is just wrong. */
  archived?: boolean;
}) {
  const [count, setCount] = useState<number | null>(null);

  // Daily Note is offered everywhere alongside the real types.
  const allTypes = useMemo(() => [...types, DAILY_NOTE_TYPE], [types]);

  // A datespan is an object ({start,end}); surface its two endpoints as separate
  // date properties (dotted keys the server reads as a json path), each carrying
  // the user's start/end labels.
  const pretty = (k: string) => k.replace(/_/g, " ");
  const expand = (f: FieldDef): FieldDef[] => {
    if (f.type !== "datespan") return [f];
    const base = f.label?.trim() || pretty(f.key);
    return [
      {
        ...f,
        key: `${f.key}.start`,
        type: "datetime",
        label: `${base} · ${f.startLabel?.trim() || "Start"}`,
      },
      {
        ...f,
        key: `${f.key}.end`,
        type: "datetime",
        label: `${base} · ${f.endLabel?.trim() || "End"}`,
      },
    ];
  };

  /**
   * What a group's "Field" conditions may talk about. Under ANY a block needs to
   * satisfy just one condition, so anything any of the types in play defines is
   * fair game. Under ALL it has to satisfy every one at once, so only keys all of
   * them define can ever match — offering the rest only invites empty results.
   */
  const fieldsFor = useCallback(
    (typeIds: Set<string>, match: FilterGroup["match"]): FieldDef[] => {
      const inPlay = allTypes.filter((t) => typeIds.has(t.id) && t.propertySchema);
      const byKey = new Map<string, FieldDef>();
      for (const t of inPlay) {
        for (const f of t.propertySchema!.fields) if (!byKey.has(f.key)) byKey.set(f.key, f);
      }
      const shared =
        match === "all" && inPlay.length > 1
          ? [...byKey.values()].filter((f) =>
              inPlay.every((t) => t.propertySchema!.fields.some((x) => x.key === f.key)),
            )
          : [...byKey.values()];
      return shared.flatMap(expand);
    },
    [allTypes],
  );

  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .post<{ count: number }>("/collections/query-preview", { filterQuery: value, archived })
        .then((r) => setCount(r.count))
        .catch(() => setCount(null));
    }, 400);
    return () => clearTimeout(t);
  }, [value, archived]);

  return (
    <div>
      <GroupEditor
        group={value}
        onChange={onChange}
        types={allTypes}
        tags={tags}
        fieldsFor={fieldsFor}
        inheritedTypes={EMPTY_TYPES}
        isRoot
      />
      {count !== null && (
        <div className="hint" style={{ marginTop: 8 }}>
          {count} {archived ? "archived " : ""}block(s) match
        </div>
      )}
      <datalist id="hn-tags">
        {tags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <datalist id="hn-dates">
        {["today", "today+1", "today+7", "today-1", "today-7", "now"].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}
