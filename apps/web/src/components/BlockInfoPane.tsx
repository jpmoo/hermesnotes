import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type BlockInfo } from "../api.ts";
import { fmtDateTime } from "../lib/format.ts";

/** Block connections drill through the info pane; collection connections link out. */
function ConnGroup({
  label,
  items,
  onSelect,
}: {
  label: string;
  items: { id: string; label: string }[];
  onSelect?: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="info-conn">
      <div className="info-conn-label">{label}</div>
      {items.map((it) =>
        onSelect ? (
          <button key={it.id} className="info-conn-item" title={it.label} onClick={() => onSelect(it.id)}>
            {it.label}
          </button>
        ) : (
          <Link key={it.id} className="info-conn-item" to={`/collections/${it.id}`} title={it.label}>
            {it.label}
          </Link>
        ),
      )}
    </div>
  );
}

/** Right-panel info pane for the currently selected block. */
export function BlockInfoPane({
  blockId,
  onSelect,
}: {
  blockId: string;
  onSelect: (id: string) => void;
}) {
  const [info, setInfo] = useState<BlockInfo | null>(null);

  useEffect(() => {
    setInfo(null);
    void api.get<BlockInfo>(`/blocks/${blockId}/info`).then(setInfo).catch(() => setInfo(null));
  }, [blockId]);

  if (!info) return <div className="hint">Loading…</div>;

  const noConnections =
    info.inCollections.length === 0 &&
    info.linksTo.length === 0 &&
    info.linkedFrom.length === 0 &&
    info.tags.length === 0;

  return (
    <div className="info-pane">
      <dl className="info-grid">
        <dt>Type</dt>
        <dd>{info.type}</dd>
        <dt>Created</dt>
        <dd>{fmtDateTime(info.createdAt)}</dd>
        <dt>Edited</dt>
        <dd>{fmtDateTime(info.updatedAt)}</dd>
        {info.attachments > 0 && (
          <>
            <dt>Files</dt>
            <dd>{info.attachments}</dd>
          </>
        )}
        <dt>ID</dt>
        <dd className="info-id">
          <code>{info.id}</code>
          <button
            className="icon-btn"
            title="Copy id"
            onClick={() => void navigator.clipboard?.writeText(info.id)}
          >
            <Copy size={12} />
          </button>
        </dd>
      </dl>

      <div className="info-conns">
        <div className="panel-h">Connections</div>
        {noConnections ? (
          <div className="hint">No connections.</div>
        ) : (
          <>
            <ConnGroup label="In collection" items={info.inCollections} />
            <ConnGroup label="Links to" items={info.linksTo} onSelect={onSelect} />
            <ConnGroup label="Linked from" items={info.linkedFrom} onSelect={onSelect} />
            {info.tags.length > 0 && (
              <div className="info-conn">
                <div className="info-conn-label">Tagged</div>
                <div className="info-tags">
                  {info.tags.map((t) => (
                    <span key={t} className="tag-chip">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
