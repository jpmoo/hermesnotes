import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Where Talaria keeps its things. One directory, under the user's own Library,
 * so nothing here needs elevated anything.
 */
export const HOME = process.env.TALARIA_HOME ?? join(homedir(), "Library", "Application Support", "Talaria");
export const CONFIG_PATH = join(HOME, "config.json");
export const MIRROR_PATH = join(HOME, "mirror.sqlite");
export const SOCKET_PATH = process.env.TALARIA_SOCKET ?? join(HOME, "talaria.sock");

const configSchema = z.object({
  /** e.g. https://app.example.com/hermesnotes — no trailing slash needed. */
  origin: z.string().url(),
  /** A Hermes access key (Settings → Access keys). */
  accessKey: z.string().min(1),
  /** How often to ask for changes while the network is up, in seconds. */
  pollSeconds: z.number().int().min(2).max(3600).default(30),
});
export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

/**
 * Read the config, or explain precisely what's missing.
 *
 * A daemon that dies at launch with a stack trace is a daemon whose failure the
 * user meets as an empty Spotlight rather than as a message, so every failure
 * here says what file, what field, and what to do.
 */
export function loadConfig(): Config {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    throw new ConfigError(
      `No config at ${CONFIG_PATH}.\n` +
        `Create it as:\n` +
        `  {\n    "origin": "https://your-hermes/hermesnotes",\n    "accessKey": "hn_…"\n  }\n` +
        `Mint the key in Hermes under Settings → Access keys, then: chmod 600 "${CONFIG_PATH}"`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${CONFIG_PATH} is not valid JSON: ${(err as Error).message}`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${CONFIG_PATH} is missing or has bad fields:\n${lines.join("\n")}`);
  }
  return result.data;
}
