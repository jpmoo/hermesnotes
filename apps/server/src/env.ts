import { z } from "zod";

const schema = z.object({
  // Optional: when absent, established by the first-run setup wizard and
  // persisted to the config file (see config.ts).
  DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 bytes").optional(),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  EMBEDDING_INDEX_DIM: z.coerce.number().default(2000),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
