import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeFilter, type PropertySchema } from "@hermes/shared";
import { attachmentBlobs,
  attachments, banners, blocks, blockTags, blockTypes, memberships, tags } from "@hermes/db";
import { db } from "../db.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { runQuery } from "../collections/query.js";
import { badRequest } from "../lib/errors.js";
import {
  blockToMarkdown,
  bodyToObsidian,
  frontmatter,
  plainTitle,
  safeName,
  type BodyResolvers,
  type ExportBlockInput,
} from "./build.js";
import { zipStore, type ZipEntry } from "./zip.js";

const firstLine = (s: string | null): string =>
  (s ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";

const extOf = (name: string): string => {
  const m = /\.[A-Za-z0-9]+$/.exec(name);
  return m ? m[0] : "";
};

const mimeExt = (mime: string): string =>
  mime === "image/png" ? ".png" : mime === "image/gif" ? ".gif" : mime === "image/jpeg" ? ".jpg" : "";

/** Allocate a unique name within a used-set (case-insensitive), suffixing " 2"… */
function unique(base: string, ext: string, used: Set<string>): string {
  let name = `${base}${ext}`;
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${base} ${n++}${ext}`;
  used.add(name.toLowerCase());
  return name;
}

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  /**
   * Export blocks as an Obsidian-compatible .zip: one markdown file per block,
   * plus an attachments/ folder (deduped). Chosen by type, by collection, or
   * both.
   *
   * **A type gets a folder; a collection gets a folder and an index.** Each
   * chosen collection becomes `Collections/<name>/`, holding its members and a
   * `<name>.md` that lists them as wikilinks in the collection's own order —
   * which is the part of a collection a folder of files cannot say by itself.
   * Its layout does not survive (a matrix's quadrants, a canvas's positions, a
   * kanban's columns): markdown has nowhere to put them, and inventing a
   * convention nobody reads would be worse than saying so.
   *
   * **Every block is written once.** A block in two chosen collections, or in a
   * chosen collection and a chosen type, lives in the first place it is found —
   * collections in the order they were asked for, then types — and every other
   * index links to it by name. Two copies of one note would be two notes in
   * Obsidian, and editing one would quietly leave the other behind.
   */
  app.post("/export", async (req, reply) => {
    const userId = requireUser(req);
    const body = z
      .object({
        typeIds: z.array(z.string().uuid()).max(100).optional(),
        collectionIds: z.array(z.string().uuid()).max(100).optional(),
      })
      .refine((b) => (b.typeIds?.length ?? 0) + (b.collectionIds?.length ?? 0) > 0, {
        message: "choose at least one type or collection",
      })
      .parse(req.body);
    const typeIds = body.typeIds ?? [];
    const collectionIds = [...new Set(body.collectionIds ?? [])];

    const rowColumns = {
      id: blocks.id,
      blockTypeId: blocks.blockTypeId,
      content: blocks.content,
      properties: blocks.properties,
    };

    // Four independent reads, issued together: every type (a collection's
    // members can be of any type, chosen or not); every owned non-archived block
    // of the chosen types (text notes include daily scratchpads + weekly
    // reflections, filtered to non-empty below); light metadata for EVERY owned
    // block, to resolve link targets (only a content PREFIX — just enough for a
    // first-line title fallback, not whole bodies); and the chosen collections.
    const [types, typeRows, metaRows, collectionRows] = await Promise.all([
      db
        .select({
          id: blockTypes.id,
          name: blockTypes.name,
          isText: blockTypes.isText,
          schema: blockTypes.propertySchema,
        })
        .from(blockTypes)
        .where(eq(blockTypes.ownerId, userId)),
      typeIds.length
        ? db
            .select(rowColumns)
            .from(blocks)
            .where(
              and(eq(blocks.ownerId, userId), isNull(blocks.archivedAt), inArray(blocks.blockTypeId, typeIds)),
            )
        : Promise.resolve([]),
      db
        .select({
          id: blocks.id,
          collectionKind: blocks.collectionKind,
          title: sql<string | null>`${blocks.properties}->>'title'`,
          today: sql<string | null>`${blocks.properties}->>'today_note'`,
          reflection: sql<string | null>`${blocks.properties}->>'review_reflection'`,
          weeklyReview: sql<string | null>`${blocks.properties}->>'weekly_review'`,
          content: sql<string | null>`left(${blocks.content}, 280)`,
        })
        .from(blocks)
        .where(eq(blocks.ownerId, userId)),
      collectionIds.length
        ? db
            .select({ id: blocks.id, collectionKind: blocks.collectionKind, properties: blocks.properties })
            .from(blocks)
            .where(
              and(
                eq(blocks.ownerId, userId),
                isNull(blocks.archivedAt),
                inArray(blocks.id, collectionIds),
                sql`${blocks.collectionKind} IS NOT NULL`,
              ),
            )
        : Promise.resolve([]),
    ]);
    const typeById = new Map(types.map((t) => [t.id, t]));
    const meta = new Map(metaRows.map((m) => [m.id, m]));
    if (typeIds.length && !typeIds.some((id) => typeById.has(id)) && !collectionRows.length) {
      throw badRequest("no exportable types selected");
    }
    // In the order they were asked for, which decides where a shared member lives.
    const byCollectionId = new Map(collectionRows.map((c) => [c.id, c]));
    const collections = collectionIds
      .map((id) => byCollectionId.get(id))
      .filter((c): c is (typeof collectionRows)[number] => c !== undefined);

    const metaTitle = (m: (typeof metaRows)[number]): string => {
      if (m.today) return `Daily Note ${m.today}`;
      if (m.title && m.title.trim()) return plainTitle(m.title);
      return firstLine(m.content) || "Untitled";
    };

    /**
     * A collection's members, in its own order — the order its page shows.
     *
     * The same split `GET /collections/:id` makes: a smart, dynamic collection's
     * membership is its query, run now, and every other kind is its membership
     * rows. A matrix is exempt from the query even when smart, because its
     * placements are always explicit and the query only fills its drawer.
     */
    const membersOf = async (c: (typeof collections)[number]): Promise<string[]> => {
      const props = (c.properties ?? {}) as Record<string, unknown>;
      if (props.membership_mode === "smart" && props.smart_mode === "dynamic" && c.collectionKind !== "matrix") {
        return (await runQuery(userId, normalizeFilter(props.filter_query))).map((b) => b.id);
      }
      const rows = await db
        .select({ id: blocks.id })
        .from(memberships)
        .innerJoin(blocks, eq(blocks.id, memberships.blockId))
        .where(
          and(
            eq(memberships.collectionId, c.id),
            eq(blocks.ownerId, userId),
            // Archived members keep their membership but are out of sight, on
            // the page and here alike.
            isNull(blocks.archivedAt),
          ),
        )
        .orderBy(asc(memberships.position));
      return rows.map((r) => r.id);
    };
    const memberLists = await Promise.all(collections.map(membersOf));

    // The members' own rows, for any not already read as part of a chosen type.
    // Nested collections are left out: they get an index of their own when they
    // were chosen too, and a line naming them when they were not.
    const haveRow = new Set(typeRows.map((r) => r.id));
    const memberIds = [...new Set(memberLists.flat())].filter((id) => !haveRow.has(id));
    const memberRows = memberIds.length
      ? await db
          .select(rowColumns)
          .from(blocks)
          .where(
            and(
              eq(blocks.ownerId, userId),
              isNull(blocks.archivedAt),
              isNull(blocks.collectionKind),
              inArray(blocks.id, memberIds),
            ),
          )
      : [];
    const rowById = new Map([...typeRows, ...memberRows].map((r) => [r.id, r]));

    // Title + folder + file name for each block we're exporting.
    interface Prepared extends ExportBlockInput {
      folder: string;
      basename: string;
    }
    const usedByFolder = new Map<string, Set<string>>();
    const usedIn = (folder: string): Set<string> => {
      const used = usedByFolder.get(folder) ?? new Set<string>();
      usedByFolder.set(folder, used);
      return used;
    };
    const prepared: Prepared[] = [];
    const exportedBasename = new Map<string, string>(); // id -> basename (for links)

    // Every collection's folder and index name, before any note takes a name:
    // the index is what `<name>.md` should mean in its own folder, and a member
    // that happens to share the collection's title is the one that gets " 2".
    // Under `Collections/` so a collection called "Task" and a type called
    // "Task" do not become one folder.
    const usedCollectionFolders = new Set<string>();
    const indexOf = new Map<string, { folder: string; basename: string }>();
    for (const c of collections) {
      const m = meta.get(c.id);
      const title = m ? metaTitle(m) : "Untitled collection";
      const folder = `Collections/${unique(safeName(title), "", usedCollectionFolders)}`;
      indexOf.set(c.id, { folder, basename: unique(safeName(title), "", usedIn(folder)) });
    }

    const placeRow = (row: (typeof typeRows)[number], folder: string): void => {
      if (exportedBasename.has(row.id)) return; // already written somewhere earlier
      const t = row.blockTypeId ? typeById.get(row.blockTypeId) : undefined;
      if (!t) return;
      // Text notes: skip empties (blank daily scratchpads etc.).
      if (t.isText && !firstLine(row.content)) return;
      const m = meta.get(row.id);
      if (!m) return;

      const title = metaTitle(m);
      const basename = unique(safeName(title), "", usedIn(folder));
      exportedBasename.set(row.id, basename);
      prepared.push({
        id: row.id,
        content: row.content,
        properties: (row.properties ?? {}) as Record<string, unknown>,
        isText: t.isText,
        schema: (t.schema as PropertySchema | null) ?? null,
        title,
        tags: [],
        attachments: [],
        titleInFrontmatter: t.isText, // text notes have no title field of their own
        folder,
        basename,
      });
    };

    collections.forEach((c, i) => {
      const folder = indexOf.get(c.id)!.folder;
      for (const id of memberLists[i] ?? []) {
        const row = rowById.get(id);
        if (row) placeRow(row, folder);
      }
    });
    for (const row of typeRows) {
      const t = row.blockTypeId ? typeById.get(row.blockTypeId) : undefined;
      if (t) placeRow(row, safeName(t.name));
    }
    if (!prepared.length && !collections.length) throw badRequest("nothing to export for those types");

    const exportedIds = prepared.map((p) => p.id);

    // Newest exported reflection — the redirect target for weekly-review links.
    let newestReflection: { date: string; name: string } | undefined;
    for (const p of prepared) {
      const m = meta.get(p.id)!;
      if (m.reflection && (!newestReflection || m.reflection > newestReflection.date)) {
        newestReflection = { date: m.reflection, name: p.basename };
      }
    }

    // Shared attachments/ folder — everything deduped by content hash so a file
    // (or banner) reused across blocks is written once.
    const byHash = new Map<string, string>();
    const usedAtt = new Set<string>();
    const attFiles: ZipEntry[] = [];
    const addFile = (baseHint: string, ext: string, data: unknown): string => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
      const hash = createHash("sha256").update(buf).digest("hex");
      let name = byHash.get(hash);
      if (!name) {
        name = unique(safeName(baseHint) || "file", ext, usedAtt);
        byHash.set(hash, name);
        attFiles.push({ name: `attachments/${name}`, data: buf });
      }
      return name;
    };

    // ── Attachments, tags, and banner images for the exported blocks —
    //    independent reads issued together. Skipped outright when nothing but
    //    empty collections was chosen: `inArray` over no ids is not a query.
    const bannerIdByBlock = new Map<string, string>();
    for (const p of prepared) {
      const bv = p.properties.banner as { id?: string } | undefined;
      if (bv?.id) bannerIdByBlock.set(p.id, bv.id);
    }
    const bannerIds = [...new Set(bannerIdByBlock.values())];
    const [attRows, tagRows, bRows] = await Promise.all([
      exportedIds.length
        ? db
            .select({
              id: attachments.id,
              blockId: attachments.blockId,
              filename: attachments.filename,
              data: attachmentBlobs.data,
            })
            .from(attachments)
            // The bytes live under their own digest now; the attachment is a
            // name and a pointer. An export still wants one file per
            // attachment, so two notes sharing a blob still get two files.
            .innerJoin(
              attachmentBlobs,
              and(
                eq(attachmentBlobs.ownerId, attachments.ownerId),
                eq(attachmentBlobs.sha256, attachments.sha256),
              ),
            )
            .where(inArray(attachments.blockId, exportedIds))
        : Promise.resolve([]),
      exportedIds.length
        ? db
            .select({ blockId: blockTags.blockId, name: tags.name })
            .from(blockTags)
            .innerJoin(tags, eq(tags.id, blockTags.tagId))
            .where(inArray(blockTags.blockId, exportedIds))
        : Promise.resolve([]),
      bannerIds.length
        ? db
            .select({ id: banners.id, mime: banners.mime, data: banners.data })
            .from(banners)
            .where(and(eq(banners.ownerId, userId), inArray(banners.id, bannerIds)))
        : Promise.resolve([] as { id: string; mime: string; data: Buffer }[]),
    ]);

    // Attachments → deduped files + a per-block listing.
    const attNameById = new Map<string, string>();
    const attByBlock = new Map<string, { id: string; name: string }[]>();
    for (const a of attRows) {
      const ext = extOf(a.filename);
      const name = addFile(a.filename.slice(0, a.filename.length - ext.length), ext, a.data);
      attNameById.set(a.id, name);
      const list = attByBlock.get(a.blockId) ?? [];
      list.push({ id: a.id, name });
      attByBlock.set(a.blockId, list);
    }

    // Banners → an attachment file + a `banner:` YAML path per block.
    const bannerPathByBlock = new Map<string, string>();
    const bById = new Map(bRows.map((b) => [b.id, b]));
    for (const [blockId, bannerId] of bannerIdByBlock) {
      const b = bById.get(bannerId);
      if (b) bannerPathByBlock.set(blockId, `attachments/${addFile("banner", mimeExt(b.mime), b.data)}`);
    }

    // Tags per exported block.
    const tagsByBlock = new Map<string, string[]>();
    for (const t of tagRows) {
      const list = tagsByBlock.get(t.blockId) ?? [];
      list.push(t.name);
      tagsByBlock.set(t.blockId, list);
    }

    // Link resolver: exported → its file base name; an exported collection → its
    // index; other collections/empties → drop; weekly-review → its reflection;
    // daily note → its scratchpad (if exported).
    const resolvers: BodyResolvers = {
      attachmentName: (id) => attNameById.get(id),
      titleOf: (id) => {
        const m = meta.get(id);
        if (!m) return undefined; // target no longer exists
        if (m.weeklyReview === "true") return newestReflection?.name; // → reflection
        const exp = exportedBasename.get(id);
        if (exp) return exp;
        if (m.collectionKind) return indexOf.get(id)?.basename; // only if it was chosen
        if (m.today || m.reflection) return undefined; // scratchpad/reflection not exported
        return metaTitle(m); // normal block not in this export → dangling wikilink
      },
    };

    // ── Render every note.
    const entries: ZipEntry[] = [];
    for (const p of prepared) {
      p.tags = tagsByBlock.get(p.id) ?? [];
      p.attachments = attByBlock.get(p.id) ?? [];
      p.bannerPath = bannerPathByBlock.get(p.id);
      const md = blockToMarkdown(p, resolvers);
      entries.push({ name: `${p.folder}/${p.basename}.md`, data: Buffer.from(md, "utf8") });
    }

    // ── And each chosen collection's index: what it is, what it says about
    //    itself, and its members in order.
    collections.forEach((c, i) => {
      const { folder, basename } = indexOf.get(c.id)!;
      const props = (c.properties ?? {}) as Record<string, unknown>;
      const m = meta.get(c.id);
      const description =
        typeof props.description === "string" && props.description.trim()
          ? bodyToObsidian(props.description, resolvers).body.trim()
          : "";
      const lines: string[] = [];
      for (const id of memberLists[i] ?? []) {
        const name = resolvers.titleOf(id);
        if (name) {
          lines.push(`- [[${name}]]`);
          continue;
        }
        // A member with no file of its own — a nested collection that was not
        // chosen. Named, so the list does not silently have a hole in it.
        const member = meta.get(id);
        if (member?.collectionKind) lines.push(`- ${metaTitle(member)}`);
      }
      const md = [
        frontmatter(
          [
            { key: "title", value: m ? metaTitle(m) : basename },
            { key: "collection", value: c.collectionKind },
          ],
          [],
        ),
        description,
        "",
        lines.length ? lines.join("\n") : "_This collection is empty._",
      ]
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd() + "\n";
      entries.push({ name: `${folder}/${basename}.md`, data: Buffer.from(md, "utf8") });
    });
    entries.push(...attFiles);

    const zip = zipStore(entries, new Date());
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="hermes-export.zip"`);
    reply.header("Content-Length", String(zip.length));
    return reply.send(zip);
  });
}
