import "./load-env.js"; // must be first — populates process.env before env.ts reads it
import { buildApp } from "./app.js";
import { env } from "./env.js";
import { initConfig } from "./config.js";
import { startEmbeddingWorker } from "./embeddings/worker.js";

async function main() {
  // Resolve config (env + persisted file), generate the auth secret if needed,
  // and connect the DB if a connection is already known. May start unconfigured.
  await initConfig();

  const app = await buildApp();
  const stopWorker = startEmbeddingWorker(app.log);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    stopWorker();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
