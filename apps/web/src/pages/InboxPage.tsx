import { Inbox as InboxIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Block, type BlockType, type Settings } from "../api.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";
import { TypedBlockCard } from "../components/TypedBlockCard.tsx";

export function InboxPage() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const typeById = new Map(types.map((t) => [t.id, t]));

  const refresh = useCallback(async () => {
    setBlocks(await api.get<Block[]>("/blocks/inbox"));
  }, []);

  useEffect(() => {
    Promise.all([
      refresh(),
      api.get<BlockType[]>("/block-types").then(setTypes),
      api.get<Settings>("/settings").then(setSettings),
    ]).finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const create = async (type: BlockType) => {
    setMenuOpen(false);
    const block = await api.post<Block>("/blocks", { blockTypeId: type.id });
    setBlocks((prev) => [block, ...prev]);
  };

  const onDeleted = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));

  // Text type first, then the rest alphabetically.
  const ordered = [...types].sort((a, b) =>
    a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1,
  );

  return (
    <>
      <h1 className="page-title title-with-icon">
        <InboxIcon size={22} color="#26282b" />
        Inbox
      </h1>
      <p className="page-sub">Atomic blocks with no parent and no children.</p>

      {settings && !settings.connected && (
        <div className="card" style={{ borderColor: "#f0e4bf", background: "#fdf9ee" }}>
          <strong className="chrome">Ollama not connected.</strong> Notes will save but stay
          un-embedded until you <Link to="/settings">connect an Ollama host</Link>.
        </div>
      )}

      <div className="row" style={{ marginBottom: 18 }}>
        <div className="nav-kebab" ref={menuRef} style={{ position: "relative" }}>
          <button className="primary" onClick={() => setMenuOpen((o) => !o)}>
            + New
          </button>
          {menuOpen && (
            <div className="menu" style={{ left: 0, right: "auto" }}>
              {ordered.map((t) => (
                <button key={t.id} className="menu-item type-item" onClick={() => void create(t)}>
                  <BlockIcon iconKey={t.isText ? "type" : t.iconKey} color={t.iconColor} size={16} />
                  <span style={{ textTransform: "capitalize" }}>{t.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">Nothing in the inbox yet.</div>
      ) : (
        blocks.map((b) => {
          const type = typeById.get(b.blockTypeId);
          if (type && !type.isText) {
            return (
              <TypedBlockCard
                key={b.id}
                block={b}
                type={type}
                onConflict={refresh}
                onDeleted={onDeleted}
              />
            );
          }
          return (
            <TextBlockEditor key={b.id} block={b} onConflict={refresh} onDeleted={onDeleted} />
          );
        })
      )}
    </>
  );
}
