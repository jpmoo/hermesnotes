import { runMigrations } from "./migrator.js";

// CLI entrypoint: `pnpm db:migrate` (uses DATABASE_URL from env).
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
