import type { FieldDef } from "@hermes/shared";
import { useMemo, useState } from "react";
import type { BlockType } from "../api.ts";
import { oneLineText } from "./display.ts";

/** Minimal shape a sortable block must expose. Both Block and Member satisfy it. */
interface Sortable {
  blockTypeId: string | null;
  properties: Record<string, unknown>;
  content: string | null;
  createdAt: string;
  updatedAt: string;
}

type SortKey = "alpha" | "created" | "edited" | `prop:${string}`;
interface SortLevel {
  key: SortKey;
  dir: "asc" | "desc";
}

const pretty = (k: string) => k.replace(/_/g, " ");

/** Field keys shared by the schemas of every block type present in `items`. */
function commonFields(items: Sortable[], types: BlockType[]): FieldDef[] {
  const typeById = new Map(types.map((t) => [t.id, t]));
  const presentIds = [...new Set(items.map((i) => i.blockTypeId))];
  let common: FieldDef[] | null = null;
  for (const id of presentIds) {
    const t = id ? typeById.get(id) : undefined;
    const fields =
      t && !t.isText && t.propertySchema
        ? t.propertySchema.fields.filter((f) => f.key !== "title")
        : [];
    common = common === null ? fields : common.filter((c) => fields.some((f) => f.key === c.key));
    if (common.length === 0) break;
  }
  return common ?? [];
}

function valueFor(b: Sortable, key: SortKey): string {
  if (key === "alpha") return oneLineText(b.properties, b.content).toLowerCase();
  if (key === "created") return b.createdAt;
  if (key === "edited") return b.updatedAt;
  const v = b.properties[key.slice(5)];
  return v == null ? "" : String(v);
}

/**
 * Multi-level sort control for a list of blocks. Sort keys: alphabetical (title,
 * falling back to description), created date, edited date, and any property
 * common to all block types represented in the list (labelled by the field's
 * label, falling back to its key). Returns the sorted array plus the control UI;
 * with no levels chosen the input order is preserved.
 */
export function useBlockSort<T extends Sortable>(
  items: T[],
  types: BlockType[],
): { sorted: T[]; sortBar: React.ReactNode; active: boolean } {
  const [levels, setLevels] = useState<SortLevel[]>([]);

  const fields = useMemo(() => commonFields(items, types), [items, types]);
  const options = useMemo(
    () => [
      { key: "alpha" as SortKey, label: "Alphabetical" },
      { key: "created" as SortKey, label: "Created" },
      { key: "edited" as SortKey, label: "Edited" },
      ...fields.map((f) => ({
        key: `prop:${f.key}` as SortKey,
        label: f.label?.trim() || pretty(f.key),
      })),
    ],
    [fields],
  );
  const labelFor = (k: SortKey) => options.find((o) => o.key === k)?.label ?? k;

  const active = levels.length > 0;
  const sorted = useMemo(() => {
    if (!active) return items;
    const copy = [...items];
    copy.sort((a, b) => {
      for (const lv of levels) {
        const va = valueFor(a, lv.key);
        const vb = valueFor(b, lv.key);
        const ea = va === "";
        const eb = vb === "";
        if (ea || eb) {
          if (ea && eb) continue;
          return ea ? 1 : -1; // empties always last
        }
        const na = Number(va);
        const nb = Number(vb);
        let r: number;
        if (lv.key !== "alpha" && va.trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
          r = na - nb;
        } else {
          r = va.localeCompare(vb);
        }
        if (r !== 0) return lv.dir === "desc" ? -r : r;
      }
      return 0;
    });
    return copy;
  }, [items, levels, active]);

  const addLevel = () => {
    const used = new Set(levels.map((l) => l.key));
    const next = options.find((o) => !used.has(o.key)) ?? options[0];
    if (next) setLevels((ls) => [...ls, { key: next.key, dir: "asc" }]);
  };
  const setLevel = (i: number, patch: Partial<SortLevel>) =>
    setLevels((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeLevel = (i: number) => setLevels((ls) => ls.filter((_, idx) => idx !== i));

  const sortBar = (
    <div className="sort-bar">
      <span className="sort-label">Sort</span>
      {levels.map((lv, i) => (
        <span className="sort-level" key={i}>
          {i > 0 && <span className="sort-then">then</span>}
          <select value={lv.key} onChange={(e) => setLevel(i, { key: e.target.value as SortKey })}>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            className="icon-btn sort-dir"
            title={lv.dir === "asc" ? "Ascending" : "Descending"}
            onClick={() => setLevel(i, { dir: lv.dir === "asc" ? "desc" : "asc" })}
          >
            {lv.dir === "asc" ? "↑" : "↓"}
          </button>
          <button className="icon-btn" title="Remove" onClick={() => removeLevel(i)}>
            ✕
          </button>
        </span>
      ))}
      <button className="ghost sort-add" onClick={addLevel}>
        {active ? "+ level" : "+ Sort"}
      </button>
      {active && (
        <button className="ghost" onClick={() => setLevels([])} title="Clear sort">
          Clear
        </button>
      )}
      {active && (
        <span className="sort-summary hint">
          {levels.map((l) => labelFor(l.key)).join(" · ")}
        </span>
      )}
    </div>
  );

  return { sorted, sortBar, active };
}
