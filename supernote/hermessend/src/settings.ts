import { PluginManager } from "sn-plugin-lib";
import { HermesFile } from "./native";

/**
 * Where this plugin is pointed, and what it may do there.
 *
 * A file in the plugin's own directory rather than AsyncStorage, which would be
 * another native dependency to link for one small object. It holds an access
 * key, so it is written through a temporary file and renamed — see
 * `HermesFileModule.writeText`.
 */
export interface Settings {
  /** The Hermes instance, as somebody typed it. */
  base: string;
  /** An access key, obtained by pairing. Absent until then. */
  token?: string;
  /** The pairing in flight, so a code survives the view being closed. */
  deviceId?: string;
  /** Types, cached — see `Hermes.types`, which costs a whole library read. */
  types?: unknown[];
  /** What was chosen last time, because it is nearly always the same again. */
  lastTypeId?: string;
}

const FILE = "hermes-send.json";

async function path(): Promise<string> {
  const dir = await PluginManager.getPluginDirPath();
  if (!dir) throw new Error("cannot resolve the plugin directory");
  return `${String(dir).replace(/\/+$/, "")}/${FILE}`;
}

export async function load(): Promise<Settings> {
  try {
    const text = await HermesFile.readText(await path());
    if (!text) return { base: "" };
    const parsed = JSON.parse(text) as Settings;
    return typeof parsed?.base === "string" ? parsed : { base: "" };
  } catch {
    // A settings file that will not parse is worth less than no settings file:
    // this way the next save fixes it, rather than every launch failing on a
    // stray byte nobody can see on a device with no text editor.
    return { base: "" };
  }
}

export async function save(next: Settings): Promise<void> {
  await HermesFile.writeText(await path(), JSON.stringify(next, null, 2));
}
