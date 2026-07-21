import { useEffect, useRef, useState } from "react";
import { api, type Block, type BlockRef } from "../api.ts";
import { firstLineHtml } from "../lib/markdown-excerpt.ts";

/** Reference picker: a dynamic search box (not a select of every block). */
export function ReferenceInput({
  refTypeId,
  value,
  onChange,
}: {
  refTypeId?: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BlockRef[]>([]);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const id = value == null ? "" : String(value);

  // Resolve the current value's label.
  useEffect(() => {
    if (!id) {
      setLabel("");
      return;
    }
    void api
      .get<Block>(`/blocks/${id}`)
      .then((b) => {
        const t = b.properties?.title;
        setLabel(
          (typeof t === "string" && t.trim()) ||
            (b.content ?? "").replace(/\s+/g, " ").trim().slice(0, 60) ||
            "Untitled",
        );
      })
      .catch(() => setLabel("(unknown)"));
  }, [id]);

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

  return (
    <div className="ref-combo" ref={ref}>
      <input
        type="text"
        value={open ? query : label}
        placeholder="Search…"
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => setQuery(e.target.value)}
      />
      {id && !open && (
        <button className="ref-clear" title="Clear" onClick={() => onChange(null)}>
          ×
        </button>
      )}
      {open && (
        <div className="menu ref-results">
          {results.map((o) => (
            <button
              key={o.id}
              className="menu-item li-md"
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
              dangerouslySetInnerHTML={{ __html: firstLineHtml(o.label) }}
            />
          ))}
          {results.length === 0 && (
            <div className="hint" style={{ padding: "6px 10px" }}>
              No matches.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
