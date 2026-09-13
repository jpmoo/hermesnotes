import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Collection } from "../api.ts";
import { CollectionIcon } from "../lib/icons.tsx";
import { usePanels } from "../lib/right-panel.tsx";

/** A collection's name as its page shows it. */
export const collectionName = (c: Pick<Collection, "properties">): string => {
  const title = c.properties?.title;
  return typeof title === "string" && title.trim() ? title.trim() : "Untitled collection";
};

/** The icon a collection wears everywhere else — the sidebar, a mention chip. */
function KindIcon({ c, size }: { c: Collection; size: number }) {
  const kind = c.collectionKind;
  return (
    <CollectionIcon
      document={kind === "document"}
      matrix={kind === "matrix"}
      table={kind === "table"}
      canvas={kind === "canvas"}
      calendar={kind === "calendar"}
      rollup={kind === "rollup"}
      smart={c.properties?.membership_mode === "smart"}
      color={(c.properties?.icon_color as string | undefined) ?? undefined}
      size={size}
    />
  );
}

/**
 * Several collections, chosen the way a relation field chooses blocks.
 *
 * The same pills, the same search box beside them, the same keyboard: type a
 * few letters and Enter takes the top match, the arrows move, Escape closes,
 * and pressing a pill's name opens that collection. A checklist of every
 * collection was fine at nine and is a wall at ninety — and it did not look like
 * anything else in Hermes that picks things, which a relation field does.
 *
 * Collections are few enough to hold in memory, so this filters the list it is
 * given rather than asking the server per keystroke the way `ReferenceInput`
 * searches blocks.
 */
export function CollectionPicker({
  collections,
  value,
  onChange,
  placeholder = "Search collections…",
}: {
  collections: Collection[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const { openBlock } = usePanels();

  const byId = new Map(collections.map((c) => [c.id, c]));
  const q = query.trim().toLowerCase();
  const available = collections.filter(
    (c) => !value.includes(c.id) && (!q || collectionName(c).toLowerCase().includes(q)),
  );

  // Enter means the top match until somebody moves: back to the first row
  // whenever what is on offer changes.
  useEffect(() => setActive(0), [query, available.length]);

  // Fixed and portaled, as `ReferenceInput` is and for its reasons: a scroll box
  // or the right panel would otherwise clip the list.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      setRect({
        left: r.left,
        top: below < 240 && r.top > 240 ? Math.max(8, r.top - 228) : r.bottom + 4,
        width: r.width,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [open, value.length, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const add = (c: Collection) => {
    if (!value.includes(c.id)) onChange([...value, c.id]);
    setQuery("");
    // Lining up several is the point here, so the list stays open for the next
    // one — unlike a relation field, where the second pick is a separate act.
    setOpen(true);
  };
  const remove = (id: string) => onChange(value.filter((x) => x !== id));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      setActive((i) => (available.length ? (i + 1) % available.length : 0));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setActive((i) => (available.length ? (i - 1 + available.length) % available.length : 0));
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = available[active];
      if (c) add(c);
    } else if (e.key === "Escape") {
      setOpen(false);
      e.preventDefault();
    } else if (e.key === "Backspace" && !query && value.length) {
      // An empty box and Backspace takes the last pill, as in any chip input.
      remove(value[value.length - 1]!);
    }
  };

  return (
    <div className="ref-combo ref-multi" ref={ref}>
      <div className="ref-chips" onClick={() => setOpen(true)}>
        {value.map((id) => {
          const c = byId.get(id);
          return (
            <span className={`ref-chip${c ? "" : " missing"}`} key={id}>
              {c && <KindIcon c={c} size={13} />}
              {c ? (
                <button
                  type="button"
                  className="ref-chip-label ref-chip-open"
                  title={`Open ${collectionName(c)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openBlock(id, { collection: true });
                  }}
                >
                  {collectionName(c)}
                </button>
              ) : (
                <span className="ref-chip-label">(gone)</span>
              )}
              <button
                type="button"
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
          );
        })}
        <input
          className="ref-chip-input"
          value={query}
          placeholder={value.length ? "Add another…" : placeholder}
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
      {open &&
        rect &&
        createPortal(
          <div
            className="menu ref-results"
            ref={popRef}
            style={{ position: "fixed", left: rect.left, top: rect.top, width: Math.max(rect.width, 220), right: "auto" }}
          >
            {available.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`menu-item type-item${i === active ? " active" : ""}`}
                ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                onClick={() => add(c)}
                onMouseEnter={() => setActive(i)}
              >
                <KindIcon c={c} size={15} />
                <span>{collectionName(c)}</span>
                <span className="hint" style={{ marginLeft: "auto" }}>{c.collectionKind}</span>
              </button>
            ))}
            {available.length === 0 && (
              <div className="hint" style={{ padding: "6px 10px" }}>
                {collections.length === 0
                  ? "No collections."
                  : q
                    ? "No collection matches that."
                    : "Every collection is already chosen."}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
