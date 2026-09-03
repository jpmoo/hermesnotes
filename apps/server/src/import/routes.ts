import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authenticate, requireUser } from "../auth/middleware.js";
import { syncTextTags } from "../blocks/routes.js";

/**
 * Bringing an Obsidian vault in.
 *
 * The reading is all in `@hermes/shared/obsidian` — pure, and run by the
 * browser first so somebody can see what an import will do before it does it.
 * What is left here is the half that needs a database: minting an id for every
 * note before any of them exist, so that a link between two notes can be
 * written at the moment the first one is created rather than patched in
 * afterwards.
 *
 * That single pass is possible because `POST /blocks` takes a caller-supplied
 * id — added there for idempotency, and worth exactly as much here. It also
 * makes a half-finished import safe to run again: the ids are new each time,
 * but a create that already landed conflicts and does nothing.
 *
 * Attachments are not handled here. Their bytes never need to reach this route
 * — the client uploads them through `POST /blocks/:id/attachments` like any
 * other file, and rewrites the markers itself, because the URL they end up at
 * depends on a path prefix that Caddy strips before this server ever sees it.
 */

const noteSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(["note", "stub", "file"]),
  title: z.string(),
  body: z.string(),
});

const bodySchema = z.object({
  notes: z.array(noteSchema).min(1).max(5000),
});

/** `[label](import:<key>)` — a link to a note that does not have an id yet.
 *  Matched whole, so that a key with nothing behind it can fall back to the
 *  label on its own rather than to `[label]()`, which is a broken link where
 *  plain words would have done. */
const IMPORT_LINK = /\[([^\]]*)\]\(import:([^)]+)\)/g;

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const mount = app.prefix ?? "";

  app.post("/import/obsidian", async (req, reply) => {
    const userId = requireUser(req);
    const { notes } = bodySchema.parse(req.body);

    // Every note gets its id here, before anything is written. A link can then
    // be resolved from the map rather than from the database.
    const ids = new Map<string, string>();
    for (const n of notes) if (!ids.has(n.key)) ids.set(n.key, randomUUID());

    const resolve = (body: string) =>
      body.replace(IMPORT_LINK, (_whole, label: string, key: string) => {
        const id = ids.get(key);
        // A key with no note behind it should not happen — the plan makes a
        // stub for every target it cannot place. If one ever does, the reader
        // keeps the words and loses only the link, which is the right way for
        // this to fail.
        return id ? `[${label}](block:${id})` : label;
      });

    const created: string[] = [];
    const failed: { key: string; error: string }[] = [];

    for (const n of notes) {
      const id = ids.get(n.key)!;
      const res = await app.inject({
        method: "POST",
        url: `${mount}/blocks`,
        headers: { authorization: req.headers.authorization ?? "" },
        cookies: (req.cookies ?? {}) as Record<string, string>,
        payload: { id, content: resolve(n.body) },
      });
      if (res.statusCode >= 400) {
        failed.push({ key: n.key, error: `${res.statusCode} ${res.body.slice(0, 200)}` });
        continue;
      }
      created.push(id);
      // Creating a block does not file it under its tags — only editing one
      // does, and an import writes each note exactly once. Rather than a second
      // write per note, this calls the very function the edit path calls, so
      // there is one rule about what counts as a tag and not two.
      await syncTextTags(userId, id, [resolve(n.body)]);
    }

    return reply.send({
      ids: Object.fromEntries(ids),
      created: created.length,
      failed,
    });
  });
}
