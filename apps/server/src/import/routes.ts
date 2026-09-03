import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireUser } from "../auth/middleware.js";
import { syncTextTags } from "../blocks/routes.js";

/**
 * Bringing an Obsidian vault in.
 *
 * The reading is all in `@hermes/shared/obsidian` — pure, and run by the
 * browser first so somebody can see what an import will do before it does it.
 * What is left here is one job the create route does not do on its own: filing
 * a note under its tags.
 *
 * **The ids are minted by the browser, and that is the point.** Notes link to
 * each other, so every id has to exist before the first note is written — and
 * once they all exist, an import can be cut into as many requests as it likes
 * without a link crossing a batch boundary and landing on nothing. Which it
 * must be: Fastify's body limit is a megabyte, and a vault of any size is
 * several. `POST /blocks` has taken a caller-supplied id since it was written,
 * for idempotency; this is the same property used for a different reason, and
 * it makes a half-finished import safe to run again — a create that already
 * landed conflicts and does nothing.
 */

const bodySchema = z.object({
  notes: z
    .array(z.object({ id: z.string().uuid(), content: z.string() }))
    .min(1)
    // A ceiling on the batch, not on the import. The client sizes its own
    // batches by bytes; this is only here so one request cannot be unbounded.
    .max(100),
});

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const mount = app.prefix ?? "";

  app.post("/import/obsidian", async (req, reply) => {
    const userId = requireUser(req);
    const { notes } = bodySchema.parse(req.body);

    let created = 0;
    const failed: { id: string; error: string }[] = [];

    for (const n of notes) {
      const res = await app.inject({
        method: "POST",
        url: `${mount}/blocks`,
        headers: { authorization: req.headers.authorization ?? "" },
        cookies: (req.cookies ?? {}) as Record<string, string>,
        payload: { id: n.id, content: n.content },
      });
      if (res.statusCode >= 400) {
        failed.push({ id: n.id, error: `${res.statusCode} ${res.body.slice(0, 160)}` });
        continue;
      }
      created++;
      // Creating a block does not file it under its tags — only editing one
      // does, and an import writes each note once. Rather than a second write
      // per note, this calls the very function the edit path calls, so there is
      // one rule about what counts as a tag and not two.
      await syncTextTags(userId, n.id, [n.content]);
    }

    return reply.send({ created, failed });
  });
}
