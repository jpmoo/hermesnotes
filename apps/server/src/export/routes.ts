import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PropertySchema } from "@hermes/shared";
import { attachments, blocks, blockTags, blockTypes, tags } from "@hermes/db";
import { db } from "../db.js";
import { authenticate, requireUser } from "../auth/middleware.js";
import { badRequest } from "../lib/errors.js";
import {
  blockToMarkdown,
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

  /** Export blocks of the chosen types as an Obsidian-compatible .zip: one
   *  markdown file per block, one folder per type, plus an attachments/ folder
   *  (deduped). Collections aren't exported. */
  app.post("/export", async (req, reply) => {
    const userId = requireUser(req);
    const { typeIds } = z
      .object({ typeIds: z.array(z.string().uuid()).min(1).max(100) })
      .parse(req.body);

    // The chosen types (name + schema + whether they're text notes).
    const types = await db
      .select({
        id: blockTypes.id,
        name: blockTypes.name,
        isText: blockTypes.isText,
        schema: blockTypes.propertySchema,
      })
      .from(blockTypes)
      .where(and(eq(blockTypes.ownerId, userId), inArray(blockTypes.id, typeIds)));
    if (!types.length) throw badRequest("no exportable types selected");
    const typeById = new Map(types.map((t) => [t.id, t]));

    // Every owned, non-archived block of a chosen type. (Text notes include the
    // daily scratchpads and weekly reflections, filtered to non-empty below.)
    const rows = await db
      .select({
        id: blocks.id,
        blockTypeId: blocks.blockTypeId,
        content: blocks.content,
        properties: blocks.properties,
      })
      .from(blocks)
      .where(
        and(
          eq(blocks.ownerId, userId),
          isNull(blocks.archivedAt),
          inArray(blocks.blockTypeId, typeIds),
        ),
      );

    // ── Metadata for EVERY owned block, to resolve link targets (including ones
    //    that aren't themselves being exported). Light columns only.
    const metaRows = await db
      .select({
        id: blocks.id,
        collectionKind: blocks.collectionKind,
        title: sql<string | null>`${blocks.properties}->>'title'`,
        today: sql<string | null>`${blocks.properties}->>'today_note'`,
        reflection: sql<string | null>`${blocks.properties}->>'review_reflection'`,
        weeklyReview: sql<string | null>`${blocks.properties}->>'weekly_review'`,
        content: blocks.content,
      })
      .from(blocks)
      .where(eq(blocks.ownerId, userId));
    const meta = new Map(metaRows.map((m) => [m.id, m]));

    const metaTitle = (m: (typeof metaRows)[number]): string => {
      if (m.today) return `Daily Note ${m.today}`;
      if (m.title && m.title.trim()) return plainTitle(m.title);
      return firstLine(m.content) || "Untitled";
    };

    // Title + folder + file name for each block we're exporting.
    interface Prepared extends ExportBlockInput {
      folder: string;
      basename: string;
    }
    const usedByFolder = new Map<string, Set<string>>();
    const prepared: Prepared[] = [];
    const exportedBasename = new Map<string, string>(); // id -> basename (for links)

    for (const row of rows) {
      const t = row.blockTypeId ? typeById.get(row.blockTypeId) : undefined;
      if (!t) continue;
      const props = (row.properties ?? {}) as Record<string, unknown>;
      const m = meta.get(row.id)!;
      // Text notes: skip empties (blank daily scratchpads etc.).
      if (t.isText && !firstLine(row.content)) continue;

      const title = metaTitle(m);
      const folder = safeName(t.name);
      const used = usedByFolder.get(folder) ?? new Set<string>();
      usedByFolder.set(folder, used);
      const basename = unique(safeName(title), "", used);
      exportedBasename.set(row.id, basename);

      prepared.push({
        id: row.id,
        content: row.content,
        properties: props,
        isText: t.isText,
        schema: (t.schema as PropertySchema | null) ?? null,
        title,
        tags: [],
        attachments: [],
        titleInFrontmatter: t.isText, // text notes have no title field of their own
        folder,
        basename,
      });
    }
    if (!prepared.length) throw badRequest("nothing to export for those types");

    const exportedIds = prepared.map((p) => p.id);

    // Newest exported reflection — the redirect target for weekly-review links.
    let newestReflection: { date: string; name: string } | undefined;
    for (const p of prepared) {
      const m = meta.get(p.id)!;
      if (m.reflection && (!newestReflection || m.reflection > newestReflection.date)) {
        newestReflection = { date: m.reflection, name: p.basename };
      }
    }

    // ── Attachments: fetch for exported blocks, dedupe by content hash.
    const attRows = exportedIds.length
      ? await db
          .select({
            id: attachments.id,
            blockId: attachments.blockId,
            filename: attachments.filename,
            data: attachments.data,
          })
          .from(attachments)
          .where(inArray(attachments.blockId, exportedIds))
      : [];
    const attNameById = new Map<string, string>();
    const attByHash = new Map<string, string>();
    const usedAtt = new Set<string>();
    const attFiles: ZipEntry[] = [];
    const attByBlock = new Map<string, { id: string; name: string }[]>();
    for (const a of attRows) {
      const buf = Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data as unknown as Uint8Array);
      const hash = createHash("sha256").update(buf).digest("hex");
      let name = attByHash.get(hash);
      if (!name) {
        const ext = extOf(a.filename);
        const base = safeName(a.filename.slice(0, a.filename.length - ext.length)) || "file";
        name = unique(base, ext, usedAtt);
        attByHash.set(hash, name);
        attFiles.push({ name: `attachments/${name}`, data: buf });
      }
      attNameById.set(a.id, name);
      const list = attByBlock.get(a.blockId) ?? [];
      list.push({ id: a.id, name });
      attByBlock.set(a.blockId, list);
    }

    // ── Tags per exported block.
    const tagRows = exportedIds.length
      ? await db
          .select({ blockId: blockTags.blockId, name: tags.name })
          .from(blockTags)
          .innerJoin(tags, eq(tags.id, blockTags.tagId))
          .where(inArray(blockTags.blockId, exportedIds))
      : [];
    const tagsByBlock = new Map<string, string[]>();
    for (const t of tagRows) {
      const list = tagsByBlock.get(t.blockId) ?? [];
      list.push(t.name);
      tagsByBlock.set(t.blockId, list);
    }

    // Link resolver: exported → its file base name; collections/empties → drop;
    // weekly-review → its reflection; daily note → its scratchpad (if exported).
    const resolvers: BodyResolvers = {
      attachmentName: (id) => attNameById.get(id),
      titleOf: (id) => {
        const m = meta.get(id);
        if (!m) return undefined; // target no longer exists
        if (m.weeklyReview === "true") return newestReflection?.name; // → reflection
        const exp = exportedBasename.get(id);
        if (exp) return exp;
        if (m.collectionKind) return undefined; // collections aren't exported
        if (m.today || m.reflection) return undefined; // scratchpad/reflection not exported
        return metaTitle(m); // normal block not in this export → dangling wikilink
      },
    };

    // ── Render every note.
    const entries: ZipEntry[] = [];
    for (const p of prepared) {
      p.tags = tagsByBlock.get(p.id) ?? [];
      p.attachments = attByBlock.get(p.id) ?? [];
      const md = blockToMarkdown(p, resolvers);
      entries.push({ name: `${p.folder}/${p.basename}.md`, data: Buffer.from(md, "utf8") });
    }
    entries.push(...attFiles);

    const zip = zipStore(entries, new Date());
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="hermes-export.zip"`);
    reply.header("Content-Length", String(zip.length));
    return reply.send(zip);
  });
}
