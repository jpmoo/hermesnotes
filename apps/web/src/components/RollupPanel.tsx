import { normalizeRollup, type RollupConfig, type RollupLevel } from "@hermes/shared";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Block, type BlockType, type Collection } from "../api.ts";
import { oneLineText } from "../lib/display.ts";
import { BlockIcon, CollectionIcon } from "../lib/icons.tsx";
import { PickBlockMenu } from "./SectionLayout.tsx";

/** A root's own label and icon, looked up once so the panel can name what it holds. */
interface RootInfo {
  id: string;
  label: string;
  collectionKind: string | null;
  blockTypeId: string | null;
}

/**
 * Configure a rollup: what sits at the top, and what hangs off each level.
 *
 * The two halves are deliberately different questions. A root is a *thing you
 * already have* — the Projects list, one note — so it's chosen by picking it. A
 * level is a *rule* — "tasks that point at the thing above" — so it's described
 * rather than picked, and applies to every parent at that depth.
 */
export function RollupPanel({
  collection,
  types,
  onSaved,
}: {
  collection: Collection;
  types: BlockType[];
  onSaved: () => void;
}) {
  const [config, setConfig] = useState<RollupConfig>(() => normalizeRollup(collection.properties.rollup));
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [picking, setPicking] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  // Re-seed when the page hands over a different rollup (navigating between two).
  useEffect(() => {
    setConfig(normalizeRollup(collection.properties.rollup));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection.id]);

  // Name the roots. A collection and a block are fetched differently, and one
  // that's since been deleted is dropped from the list rather than shown as an id.
  useEffect(() => {
    let live = true;
    void (async () => {
      const out: RootInfo[] = [];
      for (const id of config.roots) {
        try {
          const { collection: c } = await api.get<{ collection: Collection }>(`/collections/${id}`);
          out.push({
            id,
            label: oneLineText(c.properties) || "Untitled",
            collectionKind: c.collectionKind,
            blockTypeId: null,
          });
          continue;
        } catch {
          /* not a collection */
        }
        try {
          const b = await api.get<Block>(`/blocks/${id}`);
          out.push({
            id,
            label: oneLineText(b.properties, b.content) || "Untitled",
            collectionKind: null,
            blockTypeId: b.blockTypeId,
          });
        } catch {
          /* gone */
        }
      }
      if (live) setRoots(out);
    })();
    return () => {
      live = false;
    };
  }, [config.roots.join(",")]);

  const save = (next: RollupConfig) => {
    setConfig(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api.patch(`/collections/${collection.id}`, { rollup: next }).then(onSaved);
    }, 400);
  };

  const addRoot = (id: string) => {
    if (config.roots.includes(id)) return;
    save({ ...config, roots: [...config.roots, id] });
  };
  const removeRoot = (id: string) => save({ ...config, roots: config.roots.filter((r) => r !== id) });
  const setLevel = (i: number, patch: Partial<RollupLevel>) =>
    save({ ...config, levels: config.levels.map((l, x) => (x === i ? { ...l, ...patch } : l)) });
  const moveLevel = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= config.levels.length) return;
    const next = [...config.levels];
    const [lv] = next.splice(i, 1);
    next.splice(j, 0, lv!);
    save({ ...config, levels: next });
  };

  const typeById = new Map(types.map((t) => [t.id, t]));
  const ordered = [...types].sort((a, b) =>
    a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1,
  );

  return (
    <div className="ru-panel">
      <div className="panel-h">Top level</div>
      <div className="hint" style={{ marginBottom: 6 }}>
        A collection puts each of its members at the top; a note is one heading on its own.
      </div>
      <div className="sec-layout">
        {roots.map((r) => (
          <div className="sec-row" key={r.id}>
            {r.collectionKind ? (
              <CollectionIcon
                document={r.collectionKind === "document"}
                matrix={r.collectionKind === "matrix"}
                table={r.collectionKind === "table"}
                canvas={r.collectionKind === "canvas"}
                calendar={r.collectionKind === "calendar"}
                rollup={r.collectionKind === "rollup"}
                size={14}
              />
            ) : (
              <BlockIcon
                iconKey={
                  r.blockTypeId && !typeById.get(r.blockTypeId)?.isText
                    ? typeById.get(r.blockTypeId)?.iconKey ?? "type"
                    : "type"
                }
                color={r.blockTypeId ? typeById.get(r.blockTypeId)?.iconColor ?? null : null}
                size={14}
              />
            )}
            <span className="sec-label">{r.label}</span>
            <button className="icon-btn sec-remove" title="Remove" onClick={() => removeRoot(r.id)}>
              <X size={13} />
            </button>
          </div>
        ))}
        {config.roots.length === 0 && <div className="hint">Nothing at the top yet.</div>}
        {picking ? (
          <PickBlockMenu
            onAddCollection={addRoot}
            onAddNote={addRoot}
            onClose={() => setPicking(false)}
          />
        ) : (
          <button className="ghost sec-add-btn" onClick={() => setPicking(true)}>
            <Plus size={14} /> Add top level
          </button>
        )}
      </div>

      <div className="panel-divider" />
      <div className="panel-h">Levels</div>
      <div className="hint" style={{ marginBottom: 6 }}>
        Each level says what belongs under the one above it.
      </div>

      {config.levels.map((lv, i) => {
        const t = lv.typeId ? typeById.get(lv.typeId) : undefined;
        const refFields = (t?.propertySchema?.fields ?? []).filter((f) => f.type === "reference");
        return (
          <div className="ru-level" key={i}>
            <div className="ru-level-head">
              <span className="ru-level-n">Level {i + 1}</span>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" title="Move up" onClick={() => moveLevel(i, -1)}>
                <ChevronUp size={14} />
              </button>
              <button className="icon-btn" title="Move down" onClick={() => moveLevel(i, 1)}>
                <ChevronDown size={14} />
              </button>
              <button
                className="icon-btn"
                title="Remove level"
                onClick={() => save({ ...config, levels: config.levels.filter((_, x) => x !== i) })}
              >
                <X size={13} />
              </button>
            </div>

            <label className="field">
              <span>Show</span>
              <select
                value={lv.typeId ?? ""}
                onChange={(e) => setLevel(i, { typeId: e.target.value || null, refKey: null })}
              >
                <option value="">Anything</option>
                {ordered.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Connected by</span>
              <select
                value={lv.refKey ?? ""}
                onChange={(e) => setLevel(i, { refKey: e.target.value || null })}
                disabled={refFields.length === 0}
              >
                <option value="">Any reference</option>
                {refFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label?.trim() || f.key.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
            {lv.typeId && refFields.length === 0 && (
              <div className="hint">
                {t?.name ?? "This type"} has no reference field, so nothing can point at the level
                above. Add one on the type, or use members below.
              </div>
            )}

            <label className="row" style={{ gap: 8, marginTop: 6 }}>
              <input
                type="checkbox"
                checked={Boolean(lv.members)}
                style={{ width: "auto" }}
                onChange={(e) => setLevel(i, { members: e.target.checked })}
              />
              <span className="hint">Also include a collection's own members</span>
            </label>
          </div>
        );
      })}

      <button
        className="ghost sec-add-btn"
        onClick={() => save({ ...config, levels: [...config.levels, { typeId: null, refKey: null }] })}
      >
        <Plus size={14} /> Add level
      </button>
    </div>
  );
}
