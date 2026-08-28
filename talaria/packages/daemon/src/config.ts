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

/**
 * Written by the settings panel, readable by anyone.
 *
 * `Talaria.app` → menu bar → Settings… (or `open talaria://settings`) edits this
 * file and restarts the daemon; it is no longer something a person has to
 * compose by hand before anything will start. It stays a plain JSON file on
 * purpose — a config you can `cat`, diff and copy to another machine is worth
 * more than one hidden in a defaults database.
 *
 * The panel overlays rather than rewrites, so anything here that this schema
 * does not declare survives a save untouched. That matters for the four keys
 * only the app reads — `boardHotkey`, `assistantHotkey`, `glanceHotkey` and
 * `menuBarSymbol` — which zod strips on the way in and which would otherwise be
 * deleted by the first person to press Save.
 */
const configSchema = z.object({
  /** e.g. https://app.example.com/hermesnotes — no trailing slash needed. */
  origin: z.string().url(),
  /** A Hermes access key (Settings → Access keys). */
  accessKey: z.string().min(1),
  /** How often to ask for changes while the network is up, in seconds. */
  pollSeconds: z.number().int().min(2).max(3600).default(30),
  /**
   * Where Glance embeds, and with what.
   *
   * Local by default, and that is the point rather than a default: what gets
   * embedded is the front window's own words, so the machine doing the
   * embedding is the machine allowed to see them. Pointing this at a shared box
   * is a trade somebody may want, and it should be theirs to make deliberately.
   *
   * The model only has to agree with *itself*. Glance builds and keeps its own
   * index here, so nothing is ever compared against a vector Hermes made, and
   * any embedding model will do — changing it throws the local index away and
   * rebuilds. (Comparing across two models is what produces plausible nonsense,
   * which is why the index records the model that made it and forgets the lot
   * when that changes. See `glance.ts`.)
   */
  glanceUrl: z.string().url().default("http://localhost:11434"),
  glanceModel: z.string().default("nomic-embed-text:latest"),
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
   * Where `aerospace` lives, if it is not in one of the obvious places.
   *
   * A LaunchAgent's `PATH` is not your shell's, so a binary you can run by name
   * in a terminal may be unfindable to the daemon. Set this if `talaria doctor`
   * says the workspace is missing while `aerospace list-workspaces --focused`
   * works.
   */
  aerospaceCli: z.string().optional(),
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
        `Open Talaria's menu bar icon (right-click) → Settings…, or run:\n` +
        `  open talaria://settings\n` +
        `You will need a Hermes address and an access key, minted under Settings → Access keys.\n` +
        `The panel writes this file; editing it by hand still works if you would rather.`,
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
        `Mint a real one in Hermes under Settings → Access keys, then put it in via\n` +
        `  open talaria://settings`,
    );
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${CONFIG_PATH} is missing or has bad fields:\n${lines.join("\n")}`);
  }
  return result.data;
}
