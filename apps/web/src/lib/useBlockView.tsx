import type { FieldDef } from "@hermes/shared";
import { useMemo, useState, type ReactNode } from "react";
import type { BlockType } from "../api.ts";
import { oneLineText } from "./display.ts";

/** Minimal shape a viewable block must expose. Both Block and Member satisfy it. */
interface Viewable {
  id: string;
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
type ViewMode = "block" | "masonry" | "masonry-collapsed";

const VIEW_KEY = "hn.blockview.mode";
const COLS_KEY = "hn.blockview.cols";
const pretty = (k: string) => k.replace(/_/g, " ");

/** Field keys shared by the schemas of every block type present in `items`. */
function commonFields(items: Viewable[], types: BlockType[]): FieldDef[] {
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

function valueFor(b: Viewable, key: SortKey): string {
  if (key === "alpha") return oneLineText(b.properties, b.content).toLowerCase();
  if (key === "created") return b.createdAt;
  if (key === "edited") return b.updatedAt;
  const v = b.properties[key.slice(5)];
  return v == null ? "" : String(v);
}

/**
 * Sort + view controls for a block list. Sort keys: alphabetical (title, else
 * description), created, edited, and any property common to all represented
 * types (labelled by the field's label, falling back to its key). View modes:
 * vertical block list, masonry (natural height), and masonry (constant height),
 * with a persistent column count. Returns the sorted items, the toolbar UI, and
 * a `renderList` helper that lays cards out per the chosen view.
 */
export function useBlockView<T extends Viewable>(
  items: T[],
  types: BlockType[],
  opts: { enableView?: boolean } = {},
): {
  sorted: T[];
  active: boolean;
  toolbar: ReactNode;
  renderList: (renderCard: (item: T) => ReactNode) => ReactNode;
} {
  const enableView = opts.enableView ?? true;
  const [levels, setLevels] = useState<SortLevel[]>([]);
  const [viewMode, setViewModeState] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_KEY) as ViewMode) || "block",
  );
  const [columns, setColumnsState] = useState<number>(
    () => Number(localStorage.getItem(COLS_KEY)) || 3,
  );
  const setViewMode = (v: ViewMode) => {
    setViewModeState(v);
    localStorage.setItem(VIEW_KEY, v);
  };
  const setColumns = (n: number) => {
    const c = Math.min(6, Math.max(1, n));
    setColumnsState(c);
    localStorage.setItem(COLS_KEY, String(c));
  };

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

  const active = levels.length > 0;
  const sorted = useMemo(() => {
    if (!active) return items;
    const copy = [...items];
    copy.sort((a, b) => {
      for (const lv of levels) {
        const va = valueFor(a, lv.key);
        const vb = valueFor(b, lv.key);
        if (va === "" || vb === "") {
          if (va === "" && vb === "") continue;
          return va === "" ? 1 : -1; // empties last
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

  const VIEWS: { key: ViewMode; label: string }[] = [
    { key: "block", label: "Block" },
    { key: "masonry", label: "Masonry" },
    { key: "masonry-collapsed", label: "Masonry (compact)" },
  ];

  const toolbar = (
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

      {enableView && (
        <span className="view-controls">
          <div className="segmented">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                className={`seg${viewMode === v.key ? " active" : ""}`}
                onClick={() => setViewMode(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>
          {viewMode !== "block" && (
            <span className="cols-ctl">
              <span className="hint">Cols</span>
              <button className="icon-btn" onClick={() => setColumns(columns - 1)} title="Fewer columns">
                −
              </button>
              <span className="cols-n">{columns}</span>
              <button className="icon-btn" onClick={() => setColumns(columns + 1)} title="More columns">
                +
              </button>
            </span>
          )}
        </span>
      )}
    </div>
  );

  const renderList = (renderCard: (item: T) => ReactNode): ReactNode => {
    if (!enableView || viewMode === "block") {
      return (
        <div className="block-stack">
          {sorted.map((it) => (
            <div key={it.id}>{renderCard(it)}</div>
          ))}
        </div>
      );
    }
    const cls = "masonry" + (viewMode === "masonry-collapsed" ? " collapsed" : "");
    return (
      <div className={cls} style={{ columnCount: columns }}>
        {sorted.map((it) => (
          <div className="masonry-item" key={it.id}>
            {renderCard(it)}
          </div>
        ))}
      </div>
    );
  };

  return { sorted, active, toolbar, renderList };
}
