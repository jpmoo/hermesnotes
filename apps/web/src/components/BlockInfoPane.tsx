import { isPeriodicNote } from "@hermes/shared";
import { ArrowRight, CalendarDays, Copy, Maximize2, MoreHorizontal, Star, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, type Block, type BlockInfo, type BlockType, type ConnRef } from "../api.ts";
import { fmtDateTime } from "../lib/format.ts";
import { BlockIcon } from "../lib/icons.tsx";
import { emitBlockChange, emitBlockDeleted, useBlockChanged, useBlockOrigin, useBlockSync } from "../lib/block-events.ts";
import { useEditorMounted } from "../lib/editor-registry.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { ConfirmDialog, MembersChoice } from "./ConfirmDialog.tsx";
import { planConversion } from "@hermes/shared";
import { LongTextField } from "./LongTextField.tsx";
import { TextBlockEditor } from "./TextBlockEditor.tsx";
import { TypedBlockCard } from "./TypedBlockCard.tsx";

const fmtDayShort = (date: string) =>
  new Date(`${date}T00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

/** Every connection drills through the info-box history (blocks and collections). */
function ConnGroup({
  label,
  items,
  onSelect,
}: {
  label: string;
  items: ConnRef[];
  onSelect: (id: string) => void;
}) {
  const nav = useNavigate();
  if (items.length === 0) return null;
  return (
    <div className="info-conn">
      <div className="info-conn-label">{label}</div>
      {items.map((it) =>
        it.today ? (
          <button
            key={it.id}
            className="info-conn-item"
            title={`Daily note · ${fmtDayShort(it.today)}`}
            onClick={() => nav(`/today/${it.today}`)}
          >
            <CalendarDays size={14} />
            <span className="info-conn-text">Daily Note · {fmtDayShort(it.today)}</span>
          </button>
        ) : (
          <button
            key={it.id}
            className={`info-conn-item${it.archived ? " archived" : ""}`}
            title={it.label}
            onClick={() => onSelect(it.id)}
          >
            <BlockIcon iconKey={it.iconKey} color={it.iconColor} size={14} />
            <span className="info-conn-text">{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

/**
 * A collection's description — the one long-text field that saves to the
 * collection (PATCH /collections/:id), not to a block-type field. Self-contained:
 * mounts with the loaded value, debounces edits, and flushes on unmount so a save
 * in flight isn't lost when the panel closes or you pick another block. Mount it
 * keyed by collection id so each collection gets a fresh initial value.
 */
function CollectionDescription({ collectionId, initial }: { collectionId: string; initial: string }) {
  const origin = useBlockOrigin();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const pending = useRef<string | null>(null);
  const focusedRef = useRef(false);
  // The editor owns its content, so a remote change remounts it (keyed by nonce)
  // — but not while you're editing here (held until blur / the save settles).
  const [ext, setExt] = useState({ value: initial, nonce: 0 });
  const dirty = () => pending.current != null;
  const releaseSync = useBlockSync(
    collectionId,
    origin,
    (b) => setExt((e) => ({ value: String((b.properties as Record<string, unknown>)?.description ?? ""), nonce: e.nonce + 1 })),
    () => focusedRef.current || dirty(),
  );
  const commit = (v: string) => {
    void api.patch(`/collections/${collectionId}`, { description: v }).then(() => {
      emitBlockChange(collectionId, origin); // sync other surfaces (and other windows via SSE)
      if (!focusedRef.current && !dirty()) releaseSync();
    });
  };
  const save = (v: string) => {
    pending.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pending.current = null;
      timer.current = undefined;
      commit(v);
    }, 700);
  };
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        if (pending.current != null) commit(pending.current);
      }
    },
    // commit closes over stable refs/id; only re-arm when the collection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collectionId],
  );
  return (
    <LongTextField
      key={ext.nonce}
      value={ext.value}
      onChange={save}
      placeholder="Describe this collection…"
      blockId={collectionId}
      onFocusChange={(f) => {
        focusedRef.current = f;
        if (!f && !dirty()) releaseSync();
      }}
    />
  );
}

/** Right-panel info pane: an editable card for the selected block + its info. */
export function BlockInfoPane({
  blockId,
  onSelect,
  onSelectCollection,
  onDeleted,
  titleOverride,
}: {
  blockId: string;
  onSelect: (id: string) => void;
  onSelectCollection: (id: string) => void;
  onDeleted?: () => void;
  titleOverride?: string;
}) {
  const [info, setInfo] = useState<BlockInfo | null>(null);
  const [block, setBlock] = useState<Block | null>(null);
  const [types, setTypes] = useState<BlockType[]>([]);
  const [connTab, setConnTab] = useState<"active" | "archived" | "deleted">("active");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<null | "archive" | "delete" | "unarchive" | "convert">(null);
  /** The type a conversion is heading for, while the confirmation is up. */
  const [convertTo, setConvertTo] = useState<BlockType | null>(null);
  /** Whether a collection's blocks go with it. Reset whenever the dialog opens,
   *  so a decision made once is never carried into the next one. */
  const [withMembers, setWithMembers] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const nav = useNavigate();
  const { infoTick, openBlock } = usePanels();
  const { isFavorite, toggleFavorite } = usePreferences();
  // If this block already has a live editor in the viewport, the panel shows a
  // read-only preview rather than a second editor that would fight over versions.
  const editedInViewport = useEditorMounted(blockId);

  // Blank out only when the shown block changes; an infoTick bump (the block
  // was edited elsewhere, e.g. matrix region actions) refetches in place.
  useEffect(() => {
    setInfo(null);
    setBlock(null);
    setConnTab("active");
  }, [blockId]);

  // Clear a dead outbound link (its target no longer exists), then refetch the
  // info so the "Deleted" list updates in place.
  const clearDeadLink = (target: string) => {
    void api
      .post(`/blocks/${blockId}/clear-link`, { target })
      .then(() => api.get<BlockInfo>(`/blocks/${blockId}/info`).then(setInfo))
      .catch(() => {});
  };

  // Collection description lives here (not on the page) and is embedded with
  // the title, so semantic search finds the collection by purpose.
  const isCollection = Boolean(block?.collectionKind);
  /** A daily note or a weekly reflection: resolved by marker from the page that
   *  owns it, which would go looking for something that is no longer there. */
  const isSystemNote =
    (block?.properties as Record<string, unknown> | undefined)?.today_note != null ||
    (block?.properties as Record<string, unknown> | undefined)?.review_reflection != null;
  /** A smart collection's membership is a query, not a list — the server
   *  refuses to archive "its blocks", so the choice is never offered. */
  const isSmart =
    (block?.properties as Record<string, unknown> | undefined)?.membership_mode === "smart";

  useEffect(() => {
    void api.get<BlockInfo>(`/blocks/${blockId}/info`).then(setInfo).catch(() => setInfo(null));
  }, [blockId, infoTick]);
  // Any change event for this block (own edits included — mentions and canvas
  // edges alter connections) refreshes the info section in place.
  useBlockChanged(blockId, () =>
    void api.get<BlockInfo>(`/blocks/${blockId}/info`).then(setInfo).catch(() => {}),
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const loadBlock = () =>
    api
      .get<Block>(`/blocks/${blockId}`)
      .then(setBlock)
      .catch(() => setBlock(null));
  useEffect(() => {
    void loadBlock();
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, infoTick]);

  // This pane hands its `block` snapshot to a freshly mounted editor, so the
  // snapshot must not be stale. Refetch whenever the pane (re)becomes the
  // editing surface — the block's own page closed, or a viewport editor
  // released it — because that other surface may have saved since we loaded.
  // Without this, returning from the expanded view remounts the panel editor on
  // the pre-edit snapshot: fields render blank, and typing into them saves the
  // stale values back over the newer ones (properties are replaced wholesale).
  const ownsEditing =
    !titleOverride &&
    !editedInViewport &&
    pathname !== `/block/${blockId}` &&
    pathname !== `/collections/${blockId}`;
  useEffect(() => {
    if (ownsEditing) void loadBlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownsEditing, blockId]);

  if (!info) return <div className="hint">Loading…</div>;

  // Edit-in-panel — except for collections (they have their own page), the
  // block's own full page, or any block already open in a viewport editor: two
  // live editors on one block fight over versions and remount each other.
  const editable =
    block != null &&
    !block.collectionKind &&
    !titleOverride &&
    pathname !== `/block/${blockId}` &&
    !editedInViewport;
  const editorType = block?.blockTypeId ? types.find((t) => t.id === block.blockTypeId) : undefined;
  /**
   * What converting would do, worked out here rather than asked of the server.
   *
   * The same function the server runs, from `@hermes/shared` — so the sentence
   * somebody reads and the write that follows it cannot come apart. Asking the
   * server for a preview would have been a second round trip and a second place
   * for the answer to live.
   */
  const plan =
    block && convertTo && editorType
      ? planConversion(
          { content: block.content ?? null, properties: block.properties ?? {} },
          { isText: editorType.isText, schema: editorType.propertySchema },
          { isText: convertTo.isText, schema: convertTo.propertySchema },
        )
      : null;
  const convert = async () => {
    if (!block || !convertTo) return;
    await api.post(`/blocks/${block.id}/convert`, {
      blockTypeId: convertTo.id,
      version: block.version,
    });
    setConvertTo(null);
    void loadBlock();
  };

  const canvasConns = (info.canvasConnections ?? []).map((c) => ({
    ...c,
    label: `${c.label}${c.edgeLabel ? ` — “${c.edgeLabel}”` : ""} · ${c.canvasLabel}`,
  }));
  // Partition each group by state so the tabs can show active vs. archived
  // partners without per-item pills. Only outbound links can be "deleted".
  const live = <T extends { archived?: boolean }>(items: T[]) => items.filter((i) => !i.archived);
  const gone = <T extends { archived?: boolean }>(items: T[]) => items.filter((i) => i.archived);
  const deletedLinks = info.deletedLinks ?? [];
  const archivedCount =
    gone(info.inCollections).length +
    gone(info.linksTo).length +
    gone(info.linkedFrom).length +
    gone(canvasConns).length;
  const tags = editable ? [] : info.tags;
  const activeCount =
    live(info.inCollections).length +
    live(info.linksTo).length +
    live(info.linkedFrom).length +
    live(canvasConns).length +
    tags.length;
  const noConnections = activeCount === 0 && archivedCount === 0 && deletedLinks.length === 0;
  // When shown, the Active/Archived tabs pick their partition of each group.
  const pick = <T extends { archived?: boolean }>(items: T[]) =>
    connTab === "archived" ? gone(items) : live(items);

  const fav = isFavorite(blockId);
  // Expand the panel's entity into the main view — but not when it's already
  // there (its own full page) or is a daily note (shown beside the Today page).
  const fullPage = isCollection ? `/collections/${blockId}` : `/block/${blockId}`;
  const canExpand = block != null && !titleOverride && pathname !== fullPage;
  const isArchived = block?.archivedAt != null;
  // Daily notes and weekly reflections are excluded: each belongs to its date or
  // review cycle rather than to a list you file away, and the page that owns it
  // resolves it by that marker regardless of archived state. The server refuses
  // these too — this just keeps a dead button off the panel.
  const autoNote = isPeriodicNote(block?.properties);
  // Every block and collection, whether or not the panel is hosting its editor —
  // one place to look, rather than an icon here and a footer button there.
  const canManage = block != null && !titleOverride && !autoNote;

  const leaveIfShowing = () => {
    // Acting on what you're looking at would otherwise leave you on a page for
    // something no longer in any normal view.
    if (pathname === fullPage) nav(isCollection ? "/collections" : "/blocks");
  };
  const archive = async () => {
    await api.post(`/blocks/${blockId}/archive`, { members: withMembers });
    emitBlockDeleted(blockId);
    leaveIfShowing();
    void loadBlock();
  };
  const unarchive = async () => {
    await api.post(`/blocks/${blockId}/unarchive`, { members: withMembers });
    emitBlockDeleted(blockId); // drops it from the Archive listing
    void loadBlock();
  };
  const destroy = async () => {
    await api.del(isCollection ? `/collections/${blockId}` : `/blocks/${blockId}`);
    emitBlockDeleted(blockId);
    onDeleted?.();
    leaveIfShowing();
  };
  return (
    <div className="info-pane">
      <div className="info-actions">
        <button
          className={`icon-btn fav-star${fav ? " on" : ""}`}
          title={fav ? "Remove from favorites" : "Add to favorites"}
          onClick={() => toggleFavorite(blockId)}
        >
          <Star size={15} fill={fav ? "currentColor" : "none"} />
        </button>
        {canExpand && (
          <button
            className="icon-btn info-expand"
            title="Open in main view"
            onClick={() => openBlock(blockId, { collection: isCollection })}
          >
            <Maximize2 size={15} />
          </button>
        )}
        {/* Only when the panel ISN'T hosting an editable card: that card carries
            its own Archive button, and two would be one too many. This covers the
            cases that had none — anything open full-viewport (its editor is over
            there, not here) and any collection, which never edits in the panel. */}
        {canManage && (
          <div className="info-menu" ref={menuRef}>
            <button
              className="icon-btn"
              title="More actions"
              onClick={() => setMenuOpen((o) => !o)}
            >
              <MoreHorizontal size={15} />
            </button>
            {menuOpen && (
              <div className="menu">
                {isArchived ? (
                  <>
                    <button
                      className="menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        // A block on its own has nothing to decide — restoring
                        // it is what the menu item says. A collection might have
                        // taken its blocks down with it, and that is a question.
                        if (isCollection && !isSmart) {
                          setWithMembers(false);
                          setConfirming("unarchive");
                        } else {
                          void unarchive();
                        }
                      }}
                    >
                      Unarchive
                    </button>
                    <button
                      className="menu-item menu-danger"
                      onClick={() => {
                        setMenuOpen(false);
                        setConfirming("delete");
                      }}
                    >
                      Delete permanently
                    </button>
                  </>
                ) : (
                  <>
                    {/* Not offered for a collection (its kind is what it is), a
                        daily note or a reflection (resolved by marker from the
                        page that owns them) — the same refusals the server
                        makes, said here so the option never appears and then
                        fails. */}
                    {!isCollection && !isSystemNote && types.length > 1 && (
                      <>
                        <div className="menu-label">Convert to…</div>
                        {types
                          .filter((t) => t.id !== block?.blockTypeId)
                          .map((t) => (
                            <button
                              key={t.id}
                              className="menu-item type-item"
                              onClick={() => {
                                setMenuOpen(false);
                                setConvertTo(t);
                                setConfirming("convert");
                              }}
                            >
                              <BlockIcon
                                iconKey={t.isText ? "type" : t.iconKey}
                                color={t.iconColor}
                                size={15}
                              />
                              <span style={{ textTransform: "capitalize" }}>{t.name}</span>
                            </button>
                          ))}
                        <div className="menu-sep" />
                      </>
                    )}
                    <button
                      className="menu-item"
                      onClick={() => {
                        setMenuOpen(false);
                        setWithMembers(false);
                        setConfirming("archive");
                      }}
                    >
                      {isCollection ? "Archive collection" : "Archive"}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Keyed by the block alone. Including its version remounted this editor
          on every save — including a save from somewhere else, or the debounced
          one from a field you'd already moved on from — which threw away
          whatever the surviving fields were in the middle of: a half-typed
          reference search, an open picker, the caret. The editors take incoming
          changes through the sync bus, which holds them while you're typing;
          that's the mechanism for this, and it doesn't need help. */}
      {editable && block ? (
        <div className="panel-editor">
          {editorType && !editorType.isText ? (
            // Not compact: compact swaps the attachments field for a count chip
            // (invisible at 0 files) — the panel is an editing surface and
            // needs the real controls.
            <TypedBlockCard
              key={block.id}
              block={block}
              type={editorType}
              onConflict={() => void loadBlock()}
              onDeleted={() => onDeleted?.()}
              hideBanner
              noRegister
            />
          ) : (
            // Not compact: text-note compact mode is a read-only preview, and
            // the whole point here is editing.
            <TextBlockEditor
              key={block.id}
              block={block}
              type={editorType}
              onConflict={() => void loadBlock()}
              onDeleted={() => onDeleted?.()}
              hideBanner
              noRegister
            />
          )}
        </div>
      ) : (
        (titleOverride || info.title) && (
          <div className="info-title">
            {titleOverride ? (
              <CalendarDays size={18} />
            ) : (
              <BlockIcon iconKey={info.iconKey} color={info.iconColor} size={18} />
            )}
            <span className="info-title-text">{titleOverride ?? info.title}</span>
          </div>
        )
      )}
      {isCollection && block && (
        <div className="collection-desc">
          <div className="panel-h">Description</div>
          <CollectionDescription
            key={`desc-${blockId}`}
            collectionId={blockId}
            initial={String(block.properties?.description ?? "")}
          />
        </div>
      )}
      <dl className="info-grid">
        {!editable && (
          <>
            <dt>Created</dt>
            <dd>{fmtDateTime(info.createdAt)}</dd>
            <dt>Edited</dt>
            <dd>{fmtDateTime(info.updatedAt)}</dd>
          </>
        )}
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

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming === "convert"
            ? `Convert to ${convertTo?.name ?? ""}?`
            : confirming === "delete"
            ? isCollection
              ? "Delete this collection?"
              : "Delete this block?"
            : confirming === "unarchive"
              ? "Unarchive this collection?"
              : isCollection
                ? "Archive this collection?"
                : "Archive this block?"
        }
        message={
          confirming === "convert"
            ? plan?.lost.length
              ? `${editorType?.name ?? "This"} and ${convertTo?.name ?? "the new type"} don't hold the same things. What can be carried across will be; the rest goes.`
              : "Everything on this block has somewhere to go in the new type. Its links, tags, attachments and collections are untouched either way — it keeps its id."
            : confirming === "unarchive"
            ? withMembers
              ? "The collection comes back, and so does everything that went into the Archive with it."
              : "The collection comes back. Blocks archived alongside it stay in the Archive, unless you choose below to bring them back too."
            : confirming === "delete"
            ? isCollection
              ? "This permanently removes the collection. Blocks that aren't in any other collection become Unattached. This can't be undone."
              : "This permanently removes the block and its embedding. This can't be undone."
            : isCollection
              ? withMembers
                ? "The collection and every block in it are archived together. They stay in the Archive and can be brought back together."
                : "It'll be hidden from every normal view but kept in the Archive — unarchive anytime to restore it. Its blocks stay where they are, unless you choose below to archive them with it."
              : "It'll be hidden from every normal view but kept in the Archive — unarchive anytime to restore it where it was."
        }
        confirmLabel={
          confirming === "convert"
            ? `Convert to ${convertTo?.name ?? ""}`
            : confirming === "delete"
            ? "Delete"
            : confirming === "unarchive"
              ? withMembers
                ? "Unarchive it and its blocks"
                : "Unarchive"
              : withMembers
                ? "Archive it and its blocks"
                : "Archive"
        }
        danger={
          confirming === "delete" ||
          (confirming === "archive" && withMembers) ||
          (confirming === "convert" && Boolean(plan?.lost.length))
        }
        // Same bar as the Collections list: typing a word to file away one list
        // would be theatre, typing it to file away everything in it is not.
        // No typed word for a conversion, even a lossy one: what it costs is
        // itemized right there, and nothing else on this block moves. Reserving
        // the typed confirmation for the two acts that are actually hard to
        // undo is what keeps it meaning anything.
        requireText={confirming === "archive" && withMembers ? "archive" : undefined}
        onCancel={() => {
          setConfirming(null);
          setConvertTo(null);
        }}
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action === "convert") void convert();
          else if (action === "delete") void destroy();
          else if (action === "archive") void archive();
          else if (action === "unarchive") void unarchive();
        }}
      >
        {(confirming === "archive" || confirming === "unarchive") && isCollection && !isSmart && (
          <MembersChoice action={confirming} checked={withMembers} onChange={setWithMembers} />
        )}
        {confirming === "convert" && plan && (
          <div className="convert-plan">
            {plan.carried.map((c) => (
              <div className="convert-row kept" key={`k:${c.from}`}>
                <ArrowRight size={13} />
                <span>
                  <b>{c.fromLabel}</b> becomes <b>{c.toLabel}</b>
                  {/* Where a match was made on shape alone rather than on a name
                      or a declared profile, say so. A guess that admits it is a
                      guess can be corrected; one that does not becomes data. */}
                  {c.how === "shape" && <span className="hint"> — matched by shape</span>}
                </span>
              </div>
            ))}
            {plan.lost.map((l) => (
              <div className="convert-row gone" key={`l:${l.key}`}>
                <X size={13} />
                <span>
                  <b>{l.label}</b> is lost{l.shown ? <span className="hint"> — {l.shown}</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </ConfirmDialog>

      <div className="info-conns">
        <div className="panel-h">Connections</div>
        {noConnections ? (
          <div className="hint">No connections.</div>
        ) : (
          <>
            <div className="conn-tabs">
              <button
                className={`conn-tab${connTab === "active" ? " active" : ""}`}
                onClick={() => setConnTab("active")}
              >
                Active · {activeCount}
              </button>
              <button
                className={`conn-tab${connTab === "archived" ? " active" : ""}`}
                onClick={() => setConnTab("archived")}
              >
                Archived · {archivedCount}
              </button>
              <button
                className={`conn-tab${connTab === "deleted" ? " active" : ""}`}
                onClick={() => setConnTab("deleted")}
              >
                Deleted · {deletedLinks.length}
              </button>
            </div>

            {connTab === "deleted" ? (
              <div className="info-conn">
                {deletedLinks.length === 0 ? (
                  <div className="hint">No deleted connections.</div>
                ) : (
                  <div className="info-conn-label">No longer exists</div>
                )}
                {deletedLinks.map((d) => (
                  <div key={d.id} className="info-conn-item deleted">
                    <span className="info-conn-text">Deleted item · {d.id.slice(0, 8)}</span>
                    <button
                      className="conn-clear"
                      title="Clear this dead link"
                      onClick={() => clearDeadLink(d.id)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {connTab === "active" && activeCount === 0 && (
                  <div className="hint">No active connections.</div>
                )}
                {connTab === "archived" && archivedCount === 0 && (
                  <div className="hint">No archived connections.</div>
                )}
                <ConnGroup label="In collection" items={pick(info.inCollections)} onSelect={onSelectCollection} />
                <ConnGroup label="Links to" items={pick(info.linksTo)} onSelect={onSelect} />
                <ConnGroup label="Linked from" items={pick(info.linkedFrom)} onSelect={onSelect} />
                <ConnGroup label="Connected on canvas" items={pick(canvasConns)} onSelect={onSelect} />
                {connTab === "active" && tags.length > 0 && (
                  <div className="info-conn">
                    <div className="info-conn-label">Tagged</div>
                    <div className="info-tags">
                      {tags.map((t) => (
                        <span key={t} className="tag-chip">
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
