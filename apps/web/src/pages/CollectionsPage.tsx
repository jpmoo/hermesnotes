import { Library } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Collection } from "../api.ts";
import { CollectionIcon } from "../lib/icons.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { oneLineText } from "../lib/display.ts";
import { Banner, BannerAddButton, type BannerValue } from "../components/Banner.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";

function title(c: Collection): string {
  return oneLineText(c.properties) || "Untitled";
}

const KINDS = [
  { key: "list", label: "Lists" },
  { key: "document", label: "Spreads" },
  { key: "matrix", label: "Matrices" },
  { key: "table", label: "Tables" },
  { key: "canvas", label: "Canvases" },
  { key: "calendar", label: "Calendars" },
  { key: "rollup", label: "Rollups" },
] as const;

export function CollectionsPage() {
  const nav = useNavigate();
  const { selectPage } = usePanels();
  const { banner, setBanner } = usePreferences();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<Collection | null>(null);

  // Right-panel filter facets.
  const [q, setQ] = useState("");
  // Every kind selected on arrival; deselecting all shows nothing.
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(KINDS.map((k) => k.key)));
  const [membership, setMembership] = useState<"" | "smart" | "manual">("");

  const load = () =>
    api
      .get<Collection[]>("/collections")
      .then(setCollections)
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  // Arriving logs the page as the current location (clears any block selection).
  useEffect(() => {
    selectPage("collections");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Archive, not delete: a collection now follows the same path as a block —
  // out of sight but recoverable, with permanent deletion only from the Archive.
  const archive = async (c: Collection) => {
    await api.post(`/blocks/${c.id}/archive`, {});
    setDeleting(null);
    void load();
  };

  const toggleKind = (k: string) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return collections.filter((c) => {
      if (!kinds.has(c.collectionKind ?? "")) return false;
      const isSmart = c.properties.membership_mode === "smart";
      if (membership === "smart" && !isSmart) return false;
      if (membership === "manual" && isSmart) return false;
      if (needle && !title(c).toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [collections, q, kinds, membership]);

  return (
    <>
      {(banner("collections") as BannerValue | null) && (
        <Banner
          value={banner("collections") as BannerValue}
          editable
          onChange={(v) => setBanner("collections", v)}
        />
      )}
      <div className="page-head">
        <h1 className="page-title title-with-icon">
        <Library size={22} color="#26282b" />
        Collections
      </h1>
        {!(banner("collections")) && (
          <BannerAddButton className="page-head-add" onAdded={(v) => setBanner("collections", v)} />
        )}
      </div>
      <p className="page-sub">Ordered, filterable groupings of blocks.</p>

      <div className="sort-bar">
        <input
          type="text"
          autoComplete="off"
          placeholder="Name contains…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ width: 200 }}
        />
        <div className="segmented">
          {KINDS.map((k) => (
            <button
              key={k.key}
              className={`seg${kinds.has(k.key) ? " active" : ""}`}
              onClick={() => toggleKind(k.key)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="segmented">
          {(
            [
              ["", "All"],
              ["smart", "Smart"],
              ["manual", "Manual"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`seg${membership === key ? " active" : ""}`}
              onClick={() => setMembership(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {(q.trim() || kinds.size > 0 || membership) && (
        <div className="hint" style={{ marginBottom: 14 }}>
          {shown.length} of {collections.length} shown
        </div>
      )}

      {loading ? (
        <div className="hint">Loading…</div>
      ) : collections.length === 0 ? (
        <div className="hint">No collections yet.</div>
      ) : shown.length === 0 ? (
        <div className="hint">Nothing matches the filter.</div>
      ) : (
        shown.map((c) => {
          const bg = c.properties.bg_color as string | undefined;
          const text = c.properties.text_color as string | undefined;
          const style: CSSProperties = {};
          if (bg) style.background = bg;
          if (text) style.color = text;
          const isSmart = c.properties.membership_mode === "smart";
          const smartMode = (c.properties.smart_mode as string) ?? "dynamic";
          const meta = isSmart ? `Smart · ${smartMode}` : "Manual";
          const iconColor = (c.properties.icon_color as string) ?? undefined;
          return (
            <div className="card type-row" key={c.id} style={style}>
              <span className="icon-preview" title={meta}>
                <CollectionIcon
                  document={c.collectionKind === "document"}
                  matrix={c.collectionKind === "matrix"}
                  table={c.collectionKind === "table"}
                  canvas={c.collectionKind === "canvas"}
                  calendar={c.collectionKind === "calendar"}
                  rollup={c.collectionKind === "rollup"}
                  smart={isSmart}
                  size={20}
                  color={iconColor}
                />
              </span>
              <button
                className="ghost collection-open"
                style={{ flex: 1, textAlign: "left", color: text ?? undefined }}
                onClick={() => nav(`/collections/${c.id}`)}
              >
                <span className="chrome collection-name">{title(c)}</span>
                <span className="hint collection-meta" style={{ color: text ?? undefined }}>
                  {meta} · {c.collectionKind === "document" ? "spread" : c.collectionKind}
                </span>
              </button>

              <button
                className="ghost"
                style={{ color: text ?? undefined }}
                onClick={() => setDeleting(c)}
                title="Archive this collection"
              >
                Archive
              </button>
            </div>
          );
        })
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Archive “${deleting ? title(deleting) : ""}”?`}
        message="It'll be hidden from every normal view but kept in the Archive — unarchive anytime to restore it. Its blocks stay where they are."
        confirmLabel="Archive"
        danger={false}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && void archive(deleting)}
      />

    </>
  );
}
