import { X } from "lucide-react";
import { createPortal } from "react-dom";
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
  const popRef = useRef<HTMLDivElement>(null);

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
      const t = e.target as Node;
      // The list is portaled to the body — a click in it is still "inside".
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
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
    // You picked the thing you came for. Adding a second one is a new act —
    // clicking the field again (or its input) opens the list back up.
    setOpen(false);
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
  /**
   * Which row Enter takes, counting the "Create …" row as the last one.
   *
   * Starts at nought and returns there whenever the list changes, which is what
   * makes Enter mean "the first match" without anybody having pressed an arrow
   * first — the thing you actually want after typing three letters.
   */
  const canCreate = available.length === 0 && Boolean(query.trim());
  const rows = available.length + (canCreate ? 1 : 0);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query, available.length]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      // Down opens a closed list rather than moving a cursor nobody can see.
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      setActive((i) => (rows ? (i + 1) % rows : 0));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setActive((i) => (rows ? (i - 1 + rows) % rows : 0));
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = available[active];
      if (o) add(o);
      else if (canCreate) void createAndAdd();
    } else if (e.key === "Escape") {
      setOpen(false);
      e.preventDefault();
    }
  };

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
          onKeyDown={onKeyDown}
        />
      </div>
      {/* Out to the body: "fixed" is measured against the nearest transformed
          ancestor, not the window, and a canvas node lives inside a layer that
          pans and zooms by transform — so a popup positioned at window
          coordinates landed a screen away from the field that opened it, at the
          wrong scale. Nothing else needs to know; the coordinates are already
          the right ones. */}
      {open &&
        rect &&
        createPortal(
          <div
            className="menu ref-results"
            ref={popRef}
          style={{
            position: "fixed",
            left: rect.left,
            top: rect.top,
            width: Math.max(rect.width, 220),
            right: "auto",
          }}
        >
          {available.map((o, i) => (
            <button
              key={o.id}
              className={`menu-item type-item${i === active ? " active" : ""}`}
              // Keeping the keyboard's row on screen. `nearest` so arrowing down
              // a long list scrolls by a row rather than jumping it to the
              // middle every time.
              ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              onClick={() => add(o)}
              // The pointer moves the selection too, so Enter never takes a row
              // other than the one under the highlight.
              onMouseEnter={() => setActive(i)}
            >
              <BlockIcon iconKey={refType?.iconKey} color={refType?.iconColor} size={15} />
              <span className="li-md" dangerouslySetInnerHTML={{ __html: firstLineHtml(o.label) }} />
            </button>
          ))}
          {available.length === 0 &&
            (query.trim() ? (
              <button
                className={`menu-item${active === available.length ? " active" : ""}`}
                onClick={() => void createAndAdd()}
              >
                Create “{query.trim()}”
              </button>
            ) : (
              <div className="hint" style={{ padding: "6px 10px" }}>
                No matches.
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
