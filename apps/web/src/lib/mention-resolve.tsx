import { useEffect, useState } from "react";
import { api, ApiError, type Block, type BlockType } from "../api.ts";
import { oneLineText } from "./display.ts";

/**
 * Resolving a mention to the thing it points at — shared by the editor's chip
 * (a TipTap node view) and the read-only chips rendered on cards.
 *
 * The caches are module-level on purpose: the same person or project is mentioned
 * across many cards at once, and each chip resolving independently would mean one
 * request per appearance.
 */

let typesPromise: Promise<BlockType[]> | null = null;
const blockCache = new Map<string, Promise<Block | null>>();
const personCache = new Map<string, Promise<Block | null>>();

export const getTypes = (): Promise<BlockType[]> =>
  (typesPromise ??= api.get<BlockType[]>("/block-types").catch(() => []));

export const getBlock = (id: string): Promise<Block | null> => {
  const hit = blockCache.get(id);
  if (hit) return hit;
  const p = api.get<Block>(`/blocks/${id}`).catch((e) => {
    // Only a real 404 is a permanent "dead" cache; a transient failure is
    // evicted so a later render can retry (not stuck as a broken chip).
    if (!(e instanceof ApiError && e.status === 404)) blockCache.delete(id);
    return null;
  });
  blockCache.set(id, p);
  return p;
};

/** Resolve an `@name` mention: exact-title match (underscores = spaces). */
export const getByName = (name: string): Promise<Block | null> => {
  const key = name.toLowerCase();
  const hit = personCache.get(key);
  if (hit) return hit;
  const promise = (async (): Promise<Block | null> => {
    const title = name.replace(/_/g, " ");
    const found = await api
      .post<Block[]>("/blocks/query", {
        filterQuery: {
          kind: "group",
          match: "all",
          items: [{ kind: "property", key: "title", op: "eq", value: title }],
        },
      })
      .catch(() => [] as Block[]);
    return found[0] ?? null;
  })();
  personCache.set(key, promise);
  return promise;
};

export interface CollectionMeta {
  document: boolean;
  matrix: boolean;
  table: boolean;
  canvas: boolean;
  calendar: boolean;
  smart: boolean;
}

export interface MentionTarget {
  /** Block id, once known (an `@name` starts without one). */
  id: string;
  /** Label fetched for a mention that carried none (a bare `|<id>`). */
  fetchedLabel: string;
  icon: { key?: string | null; color?: string | null } | null;
  collection: boolean;
  collectionMeta?: CollectionMeta;
  /** The target no longer exists. */
  dead: boolean;
  /** It exists, but is archived. */
  archived: boolean;
}

/**
 * Look up what a mention points at. `staticId` for `|<id>`/`block:` mentions,
 * `personName` for `@name`; pass neither (or `isTag`) and it stays inert.
 */
export function useMentionTarget(
  staticId: string,
  personName: string,
  isTag: boolean,
  hasLabel: boolean,
): MentionTarget {
  const [icon, setIcon] = useState<MentionTarget["icon"]>(null);
  const [collection, setCollection] = useState(false);
  const [collectionMeta, setCollectionMeta] = useState<CollectionMeta>();
  const [resolvedId, setResolvedId] = useState("");
  const [fetchedLabel, setFetchedLabel] = useState("");
  const [dead, setDead] = useState(false);
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    if (isTag || (!staticId && !personName)) return;
    let alive = true;
    void (async () => {
      const b = staticId ? await getBlock(staticId) : await getByName(personName);
      if (!alive) return;
      if (!b) {
        setDead(true);
        return;
      }
      setDead(false);
      setArchived(Boolean(b.archivedAt));
      if (!staticId) setResolvedId(b.id);
      if (!hasLabel) {
        setFetchedLabel(oneLineText(b.properties as Record<string, unknown>, b.content) || "Untitled");
      }
      if (b.collectionKind) {
        setCollection(true);
        setCollectionMeta({
          document: b.collectionKind === "document",
          matrix: b.collectionKind === "matrix",
          table: b.collectionKind === "table",
          canvas: b.collectionKind === "canvas",
          calendar: b.collectionKind === "calendar",
          smart: (b.properties as Record<string, unknown>)?.membership_mode === "smart",
        });
        return;
      }
      const types = await getTypes();
      const t = types.find((x) => x.id === b.blockTypeId);
      if (alive) setIcon({ key: t?.isText ? "type" : t?.iconKey, color: t?.iconColor });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticId, personName, isTag]);

  return {
    id: staticId || resolvedId,
    fetchedLabel,
    icon,
    collection,
    collectionMeta,
    dead,
    archived,
  };
}

export type MentionPart =
  | { kind: "text"; text: string }
  | { kind: "mention"; href: string; label: string };

/**
 * Split stored title text into plain runs and mentions. Covers both the forms a
 * title can hold: markdown links written by the editor, and the compact tokens a
 * title field stores directly (`|<id>`, `@Name`, `#tag`).
 *
 * This is the counterpart to display.ts's flattenMentions, which throws the same
 * syntax away to get a plain string — use that for tooltips and sorting, this to
 * render.
 */
export function parseMentions(raw: string): MentionPart[] {
  const parts: MentionPart[] = [];
  // Ordered so the markdown form wins over the bare tokens inside it.
  const re =
    /\[([^\]]*)\]\((block|tag|person):([^)]+)\)|\|([0-9a-fA-F-]{36})|@([A-Za-z0-9][\w-]*)|#([A-Za-z0-9][\w-]*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m.index > last) parts.push({ kind: "text", text: raw.slice(last, m.index) });
    if (m[2]) {
      parts.push({ kind: "mention", href: `${m[2]}:${m[3]}`, label: m[1] ?? "" });
    } else if (m[4]) {
      parts.push({ kind: "mention", href: `block:${m[4]}`, label: "" });
    } else if (m[5]) {
      parts.push({ kind: "mention", href: `person:${m[5]}`, label: `@${m[5].replace(/_/g, " ")}` });
    } else if (m[6]) {
      parts.push({ kind: "mention", href: `tag:${m[6]}`, label: m[6] });
    }
    last = m.index + m[0].length;
  }
  if (last < raw.length) parts.push({ kind: "text", text: raw.slice(last) });
  return parts;
}
