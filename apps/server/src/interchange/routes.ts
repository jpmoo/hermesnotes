import type { FastifyInstance } from "fastify";
import { CONFORMANCE } from "@hermes/interchange";

/**
 * What this instance honours, asked rather than assumed.
 *
 * A manifest on an exported file describes that file. A live surface has to
 * answer before a client writes — an agent that has to attempt a write to find
 * out whether it is supported has already done the damage if it isn't.
 *
 * Unauthenticated on purpose: it says what the software can do, not what any
 * account holds. A client deciding whether it can talk to this server at all
 * should not need credentials to find out.
 */
export async function interchangeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/conformance", async () => CONFORMANCE);
}
