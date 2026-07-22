import type { Condition, FieldDef, FilterGroup, PropertyOp } from "@hermes/shared";
import { useEffect, useRef, useState } from "react";
import { api, type BlockType } from "../api.ts";
import { emptyGroup } from "../lib/filter.ts";

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

/** Collect all block-type ids referenced anywhere in the tree. */
function collectTypeIds(g: FilterGroup, out: Set<string>): void {
  for (const it of g.items) {
    if (it.kind === "group") collectTypeIds(it, out);
    else if (it.kind === "blockType" && it.typeId) out.add(it.typeId);
  }
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
  if ((t === "status" || t === "select") && field?.options?.length)
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, " ")}
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
        <select value={c.typeId} onChange={(e) => onChange({ ...c, typeId: e.target.value })}>
          {types.map((t) => (
            <option key={t.id} value={t.id} style={{ textTransform: "capitalize" }}>
              {t.name}
            </option>
          ))}
        </select>
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
          <select value={c.key} onChange={(e) => onChange({ ...c, key: e.target.value })}>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label?.trim() || f.key.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <select value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as PropertyOp })}>
            {PROP_OPS.map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
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
  fields,
  isRoot,
}: {
  group: FilterGroup;
  onChange: (g: FilterGroup) => void;
  onRemove?: () => void;
  types: BlockType[];
  tags: string[];
  fields: FieldDef[];
  isRoot: boolean;
}) {
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
            fields={fields}
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
}: {
  value: FilterGroup;
  onChange: (v: FilterGroup) => void;
  types: BlockType[];
  tags: string[];
}) {
  const [count, setCount] = useState<number | null>(null);

  // Fields available to "Field" conditions = union of the selected types' fields.
  const typeIds = new Set<string>();
  collectTypeIds(value, typeIds);
  const byKey = new Map<string, FieldDef>();
  for (const t of types) {
    if (typeIds.has(t.id) && t.propertySchema) {
      for (const f of t.propertySchema.fields) if (!byKey.has(f.key)) byKey.set(f.key, f);
    }
  }
  // A datespan is an object ({start,end}); surface its two endpoints as separate
  // date properties (dotted keys the server reads as a json path), each carrying
  // the user's start/end labels.
  const pretty = (k: string) => k.replace(/_/g, " ");
  const fields: FieldDef[] = [...byKey.values()].flatMap((f) => {
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
  });

  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .post<{ count: number }>("/collections/query-preview", { filterQuery: value })
        .then((r) => setCount(r.count))
        .catch(() => setCount(null));
    }, 400);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div>
      <GroupEditor
        group={value}
        onChange={onChange}
        types={types}
        tags={tags}
        fields={fields}
        isRoot
      />
      {count !== null && (
        <div className="hint" style={{ marginTop: 8 }}>
          {count} block(s) match
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
