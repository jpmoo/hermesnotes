import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Block, type BlockRef, type BlockType } from "../api.ts";
import { firstLineHtml } from "../lib/markdown-excerpt.ts";
import { oneLineText } from "../lib/display.ts";
import { resolveRef } from "../lib/resolve-ref.ts";
import { BlockIcon } from "../lib/icons.tsx";

/**
 * Reference picker with a dynamic search box. Holds one or more selections as
 * chips; the stored value is an array of block ids (a legacy single-id string is
 * read as a one-element list).
 */
export function ReferenceInput({
  refTypeId,
  value,
  onChange,
}: {
  refTypeId?: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const ids = Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
  const idsKey = ids.join(",");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BlockRef[]>([]);
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [refStatus, setRefStatus] = useState<Record<string, "archived" | "missing">>({});
  const [refType, setRefType] = useState<BlockType | null>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const fetched = useRef<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  // The target type's icon labels every result (all hits share the type).
  useEffect(() => {
    if (!refTypeId) return;
    void api
      .get<BlockType[]>("/block-types")
      .then((ts) => setRefType(ts.find((t) => t.id === refTypeId) ?? null))
      .catch(() => {});
  }, [refTypeId]);

  // The dropdown is position:fixed so overflow ancestors (table scroll box,
  // right panel) can't clip it — measure the combo and track scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) {
        const below = window.innerHeight - r.bottom;
        setRect({
          left: r.left,
          // Flip above when the viewport bottom is too close for the list.
          top: below < 240 && r.top > 240 ? Math.max(8, r.top - 228) : r.bottom + 4,
          width: r.width,
        });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [open, idsKey, query]);

  // Resolve labels for any selected ids we don't have yet.
  useEffect(() => {
    ids.forEach((id) => {
      if (fetched.current.has(id)) return;
      fetched.current.add(id);
      void resolveRef(id).then(({ status, block }) => {
        if (status === "error") {
          // Transient failure — don't label it deleted; let it retry next render.
          fetched.current.delete(id);
          return;
        }
        if (status === "missing" || !block) {
          setLabels((l) => ({ ...l, [id]: "(deleted)" }));
          setRefStatus((s) => ({ ...s, [id]: "missing" }));
          return;
        }
        setLabels((l) => ({ ...l, [id]: oneLineText(block.properties, block.content) || "Untitled" }));
        if (status === "archived") setRefStatus((s) => ({ ...s, [id]: "archived" }));
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // Debounced search while open.
  useEffect(() => {
    if (!open || !refTypeId) return;
    const t = setTimeout(() => {
      void api
        .get<BlockRef[]>(
          `/blocks/references?typeId=${encodeURIComponent(refTypeId)}&q=${encodeURIComponent(query)}`,
        )
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query, open, refTypeId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!refTypeId) return <span className="hint">No target type set</span>;

  const add = (o: BlockRef) => {
    if (!ids.includes(o.id)) {
      fetched.current.add(o.id);
      setLabels((l) => ({ ...l, [o.id]: o.label }));
      onChange([...ids, o.id]);
    }
    setQuery("");
  };
  const remove = (id: string) => onChange(ids.filter((x) => x !== id));

  /** No match for the typed name — create a block of the target type with it. */
  const createAndAdd = async () => {
    const title = query.trim();
    if (!title || !refTypeId) return;
    try {
      const b = await api.post<Block>("/blocks", {
        blockTypeId: refTypeId,
        properties: { title },
      });
      add({ id: b.id, label: title });
    } catch {
      /* ignore */
    }
  };

  const available = results.filter((r) => !ids.includes(r.id));

  return (
    <div className="ref-combo ref-multi" ref={ref}>
      <div className="ref-chips" onClick={() => setOpen(true)}>
        {ids.map((id) => (
          <span
            className={`ref-chip${refStatus[id] === "missing" ? " missing" : ""}${refStatus[id] === "archived" ? " archived" : ""}`}
            key={id}
          >
            <span className="ref-chip-label">{labels[id] ?? "…"}</span>
            {refStatus[id] === "archived" && <span className="ref-badge">archived</span>}
            <button
              className="ref-chip-x"
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                remove(id);
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          className="ref-chip-input"
          value={query}
          placeholder={ids.length ? "Add…" : "Search…"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore="true"
          data-lpignore="true"
          onFocus={() => setOpen(true)}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {open && rect && (
        <div
          className="menu ref-results"
          style={{
            position: "fixed",
            left: rect.left,
            top: rect.top,
            width: Math.max(rect.width, 220),
            right: "auto",
          }}
        >
          {available.map((o) => (
            <button key={o.id} className="menu-item type-item" onClick={() => add(o)}>
              <BlockIcon iconKey={refType?.iconKey} color={refType?.iconColor} size={15} />
              <span className="li-md" dangerouslySetInnerHTML={{ __html: firstLineHtml(o.label) }} />
            </button>
          ))}
          {available.length === 0 &&
            (query.trim() ? (
              <button className="menu-item" onClick={() => void createAndAdd()}>
                Create “{query.trim()}”
              </button>
            ) : (
              <div className="hint" style={{ padding: "6px 10px" }}>
                No matches.
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
