import { PluginManager } from "sn-plugin-lib";

/**
 * What the host now makes a plugin ask for.
 *
 * `sn-plugin-lib` 0.1.65 introduced a permission gate, and firmware that
 * enforces it refuses plugins built against the SDK before it — which is what
 * "this plugin does not work with this version" means on the device, and why
 * every plugin built against 0.1.43 stopped installing at once rather than one
 * of them being broken.
 *
 * Three of them matter here, and each is asked for at the moment it is needed
 * rather than all three at launch: a dialog that arrives while somebody is
 * looking at the thing it is about can be answered, and three at once before
 * anything has happened is a wall.
 */
export const WRITE = "plugin.permission.FILE:WRITE";
export const DELETE = "plugin.permission.FILE:DELETE";
export const INTERNET = "plugin.permission.INTERNET";

/** A short name for a message, since the full string is mostly namespace. */
const shortly = (permission: string) => permission.split(".").pop() ?? permission;

/**
 * Three answers, not two.
 *
 * `granted` — hold it, or the person just said yes.
 * `refused` — the SDK answered, and the answer was no.
 * `broke` — the call itself failed, which is not a refusal and must never be
 *   reported as one.
 *
 * That distinction is the whole point of this type. The first version of this
 * file caught every exception and returned false, so a host that had not
 * finished starting up, a permission name the host rejected, and a person
 * tapping "deny" all produced the same sentence on screen: *network permission
 * was refused*. One of those is a decision somebody made and the other two are
 * faults — and telling somebody they refused something they were never asked
 * about sends them looking in settings for a switch that is not there.
 */
export type Verdict =
  | { ok: true }
  | { ok: false; refused: true; permission: string }
  | { ok: false; refused: false; permission: string; why: string };

/**
 * Whether we already hold it.
 *
 * `hasPermission` answers 0 (no) or 1 (yes), and rejects if the host is not
 * ready. A rejection here is deliberately *not* fatal: it means we could not
 * find out, and the honest next move is to ask rather than to conclude.
 */
async function held(permission: string): Promise<boolean | null> {
  try {
    return (await PluginManager.hasPermission(permission)) === 1;
  } catch {
    return null;
  }
}

/**
 * Hold it, or ask for it once.
 *
 * `requestPermission` answers 0 (refused), 1 (while using) or 2 (always), so
 * anything above zero is a yes.
 */
export async function ensure(permission: string): Promise<Verdict> {
  const have = await held(permission);
  if (have === true) return { ok: true };

  // An SDK or firmware with no permission gate at all: nothing to hold and
  // nothing to ask. Refusing to work because the API is absent would be this
  // plugin breaking itself on older firmware in order to be careful about
  // newer, so absence is treated as permission.
  if (have === null && typeof PluginManager.requestPermission !== "function") {
    return { ok: true };
  }

  try {
    const answer = await PluginManager.requestPermission(permission);
    if (answer > 0) return { ok: true };
    return { ok: false, refused: true, permission };
  } catch (err) {
    return {
      ok: false,
      refused: false,
      permission,
      why: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Several, in order, stopping at the first one that does not come back ok. */
export async function ensureAll(...permissions: string[]): Promise<Verdict> {
  for (const p of permissions) {
    const verdict = await ensure(p);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/** What to put on screen. Says which of the three happened, in each case. */
export function explain(verdict: Verdict, doing: string): string {
  if (verdict.ok) return "";
  const name = shortly(verdict.permission);
  return verdict.refused
    ? `${name} permission was refused, so ${doing} cannot happen. Grant it in the plugin's permissions and try again.`
    : `could not ask for ${name} permission: ${verdict.why}`;
}
