import { z } from "zod";

const schema = z.object({
  // Optional: when absent, established by the first-run setup wizard and
  // persisted to the config file (see config.ts).
  DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 bytes").optional(),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  // Public URL of the app including any reverse-proxy subpath (used by the
  // OAuth metadata endpoints), e.g. https://app.example.com/hermesnotes
  PUBLIC_BASE: z.string().url().optional(),
  EMBEDDING_INDEX_DIM: z.coerce.number().default(2000),
  /**
   * The zone to reckon days in for a user who hasn't got one of their own — an
   * account made over the API, or by an older version that never asked.
   *
   * Without it the answer was this process's clock, which is a property of where
   * the box is hosted and nothing to do with the reader: a server running UTC is
   * already on tomorrow's date from early evening in the Americas, which is
   * enough to put an agent's "today's daily note" on the wrong day. Naming the
   * zone makes that a decision rather than an accident.
   */
  DEFAULT_TIMEZONE: z.string().max(64).optional(),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
