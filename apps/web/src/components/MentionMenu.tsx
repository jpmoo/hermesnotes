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
  create?: "person" | "tag" | "placeholder"; // present for create items
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
          // No Person type set up: name it now, decide what it is later.
          if (q.trim() && !personType)
            opts.push({
              key: "placeholder",
              label: `Note “${q.replace(/_/g, " ")}” for later`,
              create: "placeholder",
              raw: q.replace(/_/g, " "),
            });
        } else if (state.char === "|") {
          const rows = await api.get<BlockSearchResult[]>(
            `/blocks/search?includeCollections=1&q=${encodeURIComponent(q)}`,
          );
          // Collections link too; their icon comes from the kind.
          const KIND_ICON: Record<string, string> = {
            document: "file-text",
            list: "list",
            matrix: "grid-3x3",
            table: "table",
            kanban: "kanban",
            masonry: "layout-grid",
            canvas: "workflow",
            calendar: "calendar-days",
            rollup: "scroll",
          };
          opts = rows
            .filter((r) => r.blockTypeId !== personType?.id)
            .map((r) => {
              const t = types.find((x) => x.id === r.blockTypeId);
              return {
                key: r.id,
                label: r.label,
                href: `block:${r.id}`,
                iconKey: r.collectionKind
                  ? KIND_ICON[r.collectionKind] ?? "folder"
                  : t?.isText
                    ? "type"
                    : t?.iconKey,
                iconColor: r.collectionKind ? null : t?.iconColor,
              };
            });
          // Nothing by that name yet. Writing it down shouldn't have to wait
          // on deciding whether it's a project, a person or an idea — so it
          // goes in as a placeholder, and clicking it later asks.
          //
          // Underscores become spaces, the same as an @name: the trigger can't
          // take a space, so "Latino_Coalition" is how you're obliged to type a
          // two-word name — not what you meant to call the thing. Matching on
          // the spaced form too, so a block that already goes by that name is
          // offered instead of being quietly duplicated.
          const named = q.trim().replace(/_/g, " ");
          if (named && !rows.some((r) => r.label.toLowerCase() === named.toLowerCase()))
            opts.push({
              key: "placeholder",
              label: `Note “${named}” for later`,
              create: "placeholder",
              raw: named,
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
    } else if (opt.create === "placeholder") {
      const name = (opt.raw ?? "").trim();
      // Percent-encoded so a name with a paren in it cannot break the
      // markdown link the mention is stored as.
      state.select({ label: name, href: `new:${encodeURIComponent(name)}` });
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
  // Below the caret where there's room, above it where there isn't. This list
  // caps its own height and scrolls — it's a search result, and there may be
  // any number of matches — but a menu that opens downward from the last line
  // of a long note hangs off the bottom of the window, and the matches you were
  // typing towards are the ones that fall off.
  const MENU_MAX = 264; // keep in step with .mention-menu's max-height
  const MARGIN = 8;
  const below = window.innerHeight - rect.bottom - MARGIN;
  const above = rect.top - MARGIN;
  const flip = below < Math.min(MENU_MAX, above);
  const style: CSSProperties = {
    position: "fixed",
    ...(flip ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    left: Math.min(rect.left, Math.max(MARGIN, window.innerWidth - 340 - MARGIN)),
    maxHeight: Math.max(120, Math.min(MENU_MAX, flip ? above : below)),
    zIndex: 80,
  };

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
