import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Block, type BlockRef } from "../api.ts";
import { firstLineHtml } from "../lib/markdown-excerpt.ts";
import { oneLineText } from "../lib/display.ts";

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
  const fetched = useRef<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);

  // Resolve labels for any selected ids we don't have yet.
  useEffect(() => {
    ids.forEach((id) => {
      if (fetched.current.has(id)) return;
      fetched.current.add(id);
      void api
        .get<Block>(`/blocks/${id}`)
        .then((b) => setLabels((l) => ({ ...l, [id]: oneLineText(b.properties, b.content) || "Untitled" })))
        .catch(() => setLabels((l) => ({ ...l, [id]: "(unknown)" })));
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

  const available = results.filter((r) => !ids.includes(r.id));

  return (
    <div className="ref-combo ref-multi" ref={ref}>
      <div className="ref-chips" onClick={() => setOpen(true)}>
        {ids.map((id) => (
          <span className="ref-chip" key={id}>
            <span className="ref-chip-label">{labels[id] ?? "…"}</span>
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
          onFocus={() => setOpen(true)}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {open && (
        <div className="menu ref-results">
          {available.map((o) => (
            <button
              key={o.id}
              className="menu-item li-md"
              onClick={() => add(o)}
              dangerouslySetInnerHTML={{ __html: firstLineHtml(o.label) }}
            />
          ))}
          {available.length === 0 && (
            <div className="hint" style={{ padding: "6px 10px" }}>
              No matches.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
