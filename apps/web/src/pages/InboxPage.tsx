import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Block, type Settings } from "../api.ts";
import { TextBlockEditor } from "../components/TextBlockEditor.tsx";

export function InboxPage() {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    const list = await api.get<Block[]>("/blocks/inbox");
    // Merge fresh data (esp. embed status) without disturbing editor identity.
    setBlocks(list);
  }, []);

  useEffect(() => {
    Promise.all([refresh(), api.get<Settings>("/settings").then(setSettings)]).finally(() =>
      setLoading(false),
    );
  }, [refresh]);

  // Light polling so embed-status pills flip from "embedding…" to "embedded".
  useEffect(() => {
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const newNote = async () => {
    setCreating(true);
    try {
      const block = await api.post<Block>("/blocks", { content: "" });
      setBlocks((prev) => [block, ...prev]);
    } finally {
      setCreating(false);
    }
  };

  const onDeleted = (id: string) => setBlocks((prev) => prev.filter((b) => b.id !== id));

  return (
    <>
      <h1 className="page-title">Inbox</h1>
      <p className="page-sub">
        Atomic blocks with no parent and no children. Add one and it embeds automatically.
      </p>

      {settings && !settings.connected && (
        <div className="card" style={{ borderColor: "#f0e4bf", background: "#fdf9ee" }}>
          <strong className="chrome">Ollama not connected.</strong> Notes will save but stay
          un-embedded until you <Link to="/settings">connect an Ollama host and pick an embed
          model</Link>.
        </div>
      )}

      <div className="row" style={{ marginBottom: 18 }}>
        <button className="primary" onClick={() => void newNote()} disabled={creating}>
          + New note
        </button>
        <button className="ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="hint">Loading…</div>
      ) : blocks.length === 0 ? (
        <div className="hint">Nothing in the inbox yet.</div>
      ) : (
        blocks.map((b) => (
          <TextBlockEditor key={b.id} block={b} onConflict={refresh} onDeleted={onDeleted} />
        ))
      )}
    </>
  );
}
