import { useEffect, useState } from "react";
import { api } from "../api.ts";

/** Inline tag chips for a block. Persists to /blocks/:id/tags. */
export function TagEditor({ blockId, refresh = 0 }: { blockId: string; refresh?: number }) {
  const [tags, setTags] = useState<string[]>([]);
  const [input, setInput] = useState("");
  /**
   * Every tag already in use, offered as you type.
   *
   * Without it this was a plain box, so the only way to reuse a tag was to
   * remember it exactly and spell it the same — and a tag misspelt once is a
   * second tag for ever, quietly splitting everything filed under it.
   */
  const [known, setKnown] = useState<string[]>([]);

  useEffect(() => {
    void api.get<string[]>(`/blocks/${blockId}/tags`).then(setTags).catch(() => setTags([]));
  }, [blockId, refresh]);

  useEffect(() => {
    void api
      .get<{ name: string }[]>("/tags")
      .then((rows) => setKnown(rows.map((r) => r.name)))
      .catch(() => setKnown([]));
    // Re-read when this block's tags change: adding one here makes it a tag
    // everything else can be given too.
  }, [refresh, tags.length]);

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
        // No autocomplete="off" here, deliberately: it is reported to suppress
        // the datalist in some browsers, and it buys nothing — this input has no
        // `name`, so the browser has no form history to offer against it.
        // The browser's own list: it filters as you type and takes the keyboard
        // with it, and it can't fight the blur-to-commit below the way a
        // hand-built dropdown would — a click on a suggestion blurs the input
        // first, which would commit the half-typed word instead.
        list={`hn-tags-${blockId}`}
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
      <datalist id={`hn-tags-${blockId}`}>
        {known
          .filter((t) => !tags.includes(t))
          .map((t) => (
            <option key={t} value={t} />
          ))}
      </datalist>
    </div>
  );
}
