import type { Condition, FilterQuery, PropertyOp } from "@hermes/shared";
import { useEffect, useRef, useState } from "react";
import { api, type BlockType } from "../api.ts";

type Kind = Condition["kind"];

const KIND_LABELS: Record<Kind, string> = {
  blockType: "Block type",
  created: "Created",
  edited: "Edited",
  tag: "Tag",
  property: "Field",
  text: "Text",
  semantic: "Semantic",
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

function defaultCondition(kind: Kind, types: BlockType[]): Condition {
  switch (kind) {
    case "blockType":
      return { kind, typeId: types.find((t) => !t.isText)?.id ?? types[0]?.id ?? "" };
    case "created":
    case "edited":
      return { kind, op: "after", date: "" };
    case "tag":
      return { kind, tag: "" };
    case "property":
      return { kind, key: "", op: "eq", value: "" };
    case "text":
      return { kind, value: "" };
    case "semantic":
      return { kind, value: "", floor: 0.75 };
  }
}

function ConditionRow({
  c,
  types,
  tags,
  onChange,
  onRemove,
}: {
  c: Condition;
  types: BlockType[];
  tags: string[];
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
          <input type="date" value={c.date} onChange={(e) => onChange({ ...c, date: e.target.value })} />
        </>
      )}

      {c.kind === "tag" && (
        <input
          type="text"
          list="hn-tags"
          placeholder="tag"
          value={c.tag}
          onChange={(e) => onChange({ ...c, tag: e.target.value })}
        />
      )}

      {c.kind === "property" && (
        <>
          <input
            className="cond-key"
            placeholder="field key"
            value={c.key}
            onChange={(e) => onChange({ ...c, key: e.target.value })}
          />
          <select value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as PropertyOp })}>
            {PROP_OPS.map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
          </select>
          {c.op !== "empty" && c.op !== "notEmpty" && (
            <input
              placeholder="value"
              value={c.value ?? ""}
              onChange={(e) => onChange({ ...c, value: e.target.value })}
            />
          )}
        </>
      )}

      {c.kind === "text" && (
        <input
          placeholder="keyword"
          value={c.value}
          onChange={(e) => onChange({ ...c, value: e.target.value })}
        />
      )}

      {c.kind === "semantic" && (
        <>
          <input
            placeholder="meaning…"
            value={c.value}
            onChange={(e) => onChange({ ...c, value: e.target.value })}
          />
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
      <datalist id="hn-tags">
        {tags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </div>
  );
}

export function QueryBuilder({
  value,
  onChange,
  types,
  tags,
}: {
  value: FilterQuery;
  onChange: (v: FilterQuery) => void;
  types: BlockType[];
  tags: string[];
}) {
  const [count, setCount] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      void api
        .post<{ count: number }>("/collections/query-preview", { filterQuery: value })
        .then((r) => setCount(r.count))
        .catch(() => setCount(null));
    }, 400);
    return () => clearTimeout(t);
  }, [value]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const setAt = (i: number, c: Condition) =>
    onChange({ ...value, conditions: value.conditions.map((x, idx) => (idx === i ? c : x)) });
  const removeAt = (i: number) =>
    onChange({ ...value, conditions: value.conditions.filter((_, idx) => idx !== i) });
  const add = (kind: Kind) => {
    onChange({ ...value, conditions: [...value.conditions, defaultCondition(kind, types)] });
    setMenuOpen(false);
  };

  return (
    <div className="query-builder">
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <span className="hint">Match</span>
        <div className="segmented">
          {(["all", "any"] as const).map((m) => (
            <button
              key={m}
              className={`seg${value.match === m ? " active" : ""}`}
              onClick={() => onChange({ ...value, match: m })}
            >
              {m}
            </button>
          ))}
        </div>
        <span className="hint">of:</span>
      </div>

      {value.conditions.map((c, i) => (
        <ConditionRow
          key={i}
          c={c}
          types={types}
          tags={tags}
          onChange={(nc) => setAt(i, nc)}
          onRemove={() => removeAt(i)}
        />
      ))}

      <div className="row" style={{ marginTop: 8, gap: 12 }}>
        <div className="nav-kebab" ref={menuRef} style={{ position: "relative" }}>
          <button className="ghost" onClick={() => setMenuOpen((o) => !o)}>
            + Add condition
          </button>
          {menuOpen && (
            <div className="menu" style={{ left: 0, right: "auto" }}>
              {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
                <button key={k} className="menu-item" onClick={() => add(k)}>
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
          )}
        </div>
        {count !== null && <span className="hint">{count} block(s) match</span>}
      </div>
    </div>
  );
}
