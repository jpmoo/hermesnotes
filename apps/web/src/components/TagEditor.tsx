import { useEffect, useState } from "react";
import { api } from "../api.ts";

/** Inline tag chips for a block. Persists to /blocks/:id/tags. */
export function TagEditor({ blockId, refresh = 0 }: { blockId: string; refresh?: number }) {
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    void api.get<string[]>(`/blocks/${blockId}/tags`).then(setTags).catch(() => setTags([]));
  }, [blockId, refresh]);

  const save = (next: string[]) => {
    setTags(next);
    void api.put(`/blocks/${blockId}/tags`, { tags: next });
  };
  const add = () => {
    const v = input.trim().toLowerCase();
    if (v && !tags.includes(v)) save([...tags, v]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      {tags.map((t) => (
        <span className="tag-chip" key={t}>
          {t}
          <button onClick={() => save(tags.filter((x) => x !== t))} title="Remove tag">
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        placeholder="+ tag"
        autoComplete="off"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}
