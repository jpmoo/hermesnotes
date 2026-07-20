import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { runMigrations } from "./migrator.js";

// CLI entrypoint: `pnpm db:migrate`. Loads the repo-root .env so DATABASE_URL
// is picked up without an inline prefix.
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env") });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

runMigrations(url)
  .then(() => {
    console.log("migrations up to date");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
