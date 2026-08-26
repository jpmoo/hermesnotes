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
  /**
   * Bundle ids never recorded in the context record — not the app, not the
   * title, not at all.
   *
   * A user-owned list on top of the floor in `context.ts`. Anything here is
   * invisible to ranking and defaulting, which is the price of it being
   * invisible to the record, and that is the correct trade to leave to a person
   * rather than guess at.
   */
  contextExclude: z.array(z.string()).default([]),
  /**
   * Where `rift-cli` lives, if it is not in one of the obvious places.
   *
   * A LaunchAgent's `PATH` is not your shell's, so a binary you can run by name
   * in a terminal may be unfindable to the daemon. Set this if `talaria doctor`
   * says the workspace is missing while `rift-cli query workspaces` works.
   */
  riftCli: z.string().optional(),
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
  // The example file ships with this in it. Left as-is it would sail through
  // validation and fail later as a 401, which reads as a revoked key rather than
  // as a config nobody has filled in yet.
  if ((parsed as { accessKey?: unknown })?.accessKey === "PASTE_YOUR_ACCESS_KEY") {
    throw new ConfigError(
      `${CONFIG_PATH} still has the placeholder access key in it.\n` +
        `Mint a real one in Hermes under Settings → Access keys and paste it into "accessKey".`,
    );
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${CONFIG_PATH} is missing or has bad fields:\n${lines.join("\n")}`);
  }
  return result.data;
}
