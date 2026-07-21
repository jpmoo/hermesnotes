import { Hash, Plus } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api, type Block, type BlockRef, type BlockSearchResult, type BlockType } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import type { MentionHandlers, MentionState } from "../lib/mentions.ts";

interface Opt {
  key: string;
  label: string;
  href?: string; // present for direct-insert items
  create?: "person" | "tag"; // present for create items
  raw?: string; // the query, for create
  iconKey?: string | null;
  iconColor?: string | null;
  tag?: boolean;
}

/** Dropdown for the @ / # / | mention triggers. */
export function MentionMenu({
  state,
  keydown,
  onClose,
}: {
  state: MentionState;
  keydown: MentionHandlers["keydown"];
  onClose: () => void;
}) {
  const [types, setTypes] = useState<BlockType[]>([]);
  const [options, setOptions] = useState<Opt[]>([]);
  const [index, setIndex] = useState(0);

  const personType = types.find((t) => !t.isText && t.name.toLowerCase() === "person");

  useEffect(() => {
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const q = state.query;
    const timer = setTimeout(async () => {
      let opts: Opt[] = [];
      try {
        if (state.char === "@") {
          if (personType) {
            const rows = await api.get<BlockRef[]>(
              `/blocks/references?typeId=${personType.id}&q=${encodeURIComponent(q)}`,
            );
            opts = rows.map((r) => ({
              key: r.id,
              label: r.label,
              href: `block:${r.id}`,
              iconKey: personType.iconKey,
              iconColor: personType.iconColor,
            }));
          }
          if (q.trim() && personType)
            opts.push({ key: "create", label: `Create person “${q.replace(/_/g, " ")}”`, create: "person", raw: q });
        } else if (state.char === "|") {
          const rows = await api.get<BlockSearchResult[]>(`/blocks/search?q=${encodeURIComponent(q)}`);
          opts = rows
            .filter((r) => r.blockTypeId !== personType?.id)
            .map((r) => {
              const t = types.find((x) => x.id === r.blockTypeId);
              return {
                key: r.id,
                label: r.label,
                href: `block:${r.id}`,
                iconKey: t?.isText ? "type" : t?.iconKey,
                iconColor: t?.iconColor,
              };
            });
        } else {
          const tags = await api.get<{ name: string }[]>("/tags");
          const ql = q.toLowerCase();
          opts = tags
            .filter((t) => t.name.toLowerCase().includes(ql))
            .map((t) => ({ key: `t:${t.name}`, label: `#${t.name}`, href: `tag:${t.name}`, tag: true }));
          if (q.trim() && !tags.some((t) => t.name.toLowerCase() === ql))
            opts.push({ key: "create", label: `Create tag “#${q}”`, create: "tag", raw: q });
        }
      } catch {
        opts = [];
      }
      if (alive) {
        setOptions(opts);
        setIndex(0);
      }
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [state.char, state.query, types, personType]);

  const choose = async (opt: Opt) => {
    if (opt.href) {
      state.select({ label: opt.label, href: opt.href });
    } else if (opt.create === "person" && personType) {
      const name = (opt.raw ?? "").replace(/_/g, " ").trim();
      try {
        const b = await api.post<Block>("/blocks", {
          blockTypeId: personType.id,
          properties: { title: name },
        });
        state.select({ label: name, href: `block:${b.id}` });
      } catch {
        /* ignore */
      }
    } else if (opt.create === "tag") {
      const name = (opt.raw ?? "").trim();
      await api.post("/tags", { name }).catch(() => {});
      state.select({ label: `#${name}`, href: `tag:${name}` });
    }
    onClose();
  };

  useEffect(() => {
    keydown.current = (e) => {
      if (e.key === "ArrowDown") {
        setIndex((i) => Math.min(options.length - 1, i + 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        setIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const o = options[index];
        if (o) void choose(o);
        return true;
      }
      if (e.key === "Escape") {
        onClose();
        return true;
      }
      return false;
    };
    return () => {
      keydown.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, index, personType]);

  const rect = state.rect();
  if (!rect) return null;
  const style: CSSProperties = { position: "fixed", top: rect.bottom + 4, left: rect.left, zIndex: 80 };

  return createPortal(
    <div className="mention-menu" style={style}>
      {options.length === 0 ? (
        <div className="hint" style={{ padding: "6px 10px" }}>
          No matches
        </div>
      ) : (
        options.map((o, i) => (
          <button
            key={o.key}
            className={`mention-item${i === index ? " active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              void choose(o);
            }}
          >
            {o.tag ? (
              <Hash size={14} />
            ) : o.create ? (
              <Plus size={14} />
            ) : (
              <BlockIcon iconKey={o.iconKey} color={o.iconColor} size={14} />
            )}
            <span className="mention-label">{o.tag ? o.label.replace(/^#/, "") : o.label}</span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
