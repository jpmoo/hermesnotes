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

/** Whether we already hold it. `hasPermission` answers 0 or 1. */
async function held(permission: string): Promise<boolean> {
  try {
    return (await PluginManager.hasPermission(permission)) === 1;
  } catch {
    // An SDK or firmware without the gate. Nothing to hold, nothing to ask —
    // and refusing to work because a permission API is absent would be this
    // plugin breaking itself on older firmware to be careful about newer.
    return true;
  }
}

/**
 * Hold it, or ask for it once.
 *
 * `requestPermission` answers 0 (refused), 1 (while using) or 2 (always), so
 * anything above zero is a yes. A refusal is returned rather than thrown: the
 * caller knows what it was about to do and can say so, which is a better
 * sentence than any this function could write.
 */
export async function ensure(permission: string): Promise<boolean> {
  if (await held(permission)) return true;
  try {
    return (await PluginManager.requestPermission(permission)) > 0;
  } catch {
    return false;
  }
}

/** Several, in order, stopping at the first refusal. */
export async function ensureAll(...permissions: string[]): Promise<string | null> {
  for (const p of permissions) {
    if (!(await ensure(p))) return p;
  }
  return null;
}
