import type { ContextRow, Mirror } from "./mirror.js";

/**
 * What the machine was doing, lately.
 *
 * The mirror holds the rows; this decides what is allowed into them and what
 * comes back out. Kept apart from `mirror.ts` because the storage is trivial and
 * the policy is the entire substance: a window-title stream is the most
 * revealing telemetry available on a Mac — more than browser history — and the
 * rules about what is dropped need to be in one readable place rather than
 * spread through a schema.
 *
 * Three properties this must keep:
 *
 * - **It never leaves the machine.** Nothing here is synced, exported, or sent
 *   to Hermes. It is not part of the interchange envelope and never will be.
 * - **It decays.** A rolling window, not a history.
 * - **It is derived, never truth.** Consumers use it to rank, default and
 *   scope. Nothing may store a context row as a fact about the library.
 */

/** How long a row lives. Long enough to answer "a moment ago", short enough not to be a diary. */
export const WINDOW_HOURS = 8;

/**
 * Applications that are never the answer to "what was I working in".
 *
 * A launcher is frontmost precisely when somebody is asking, so recording it
 * would overwrite the answer with the question. They are skipped on read rather
 * than dropped on write, because *that Alfred was open* is occasionally worth
 * seeing in `talaria context` while never being worth acting on.
 *
 * Talaria's own surfaces are here for the same reason: opening the board to
 * find a card should not make the board the context.
 */
export const LAUNCHERS = [
  "com.runningwithcrayons.Alfred",
  "com.raycast.macos",
  "com.apple.Spotlight",
  "com.hegenberg.BetterTouchTool",
  "com.stairways.keyboardmaestro.engine",
  "dev.talaria.Talaria",
];

/**
 * Applications you pass through rather than work in.
 *
 * A different case from a launcher, and the distinction is worth keeping: a
 * launcher is frontmost because you are *asking*, a transient is frontmost
 * because something briefly needed you. Both are wrong answers to "what am I
 * working on", for different reasons.
 *
 * Every entry here was observed rather than imagined — a notification stealing
 * focus for two seconds, and a password manager visited mid-task — and the list
 * should keep growing that way. Guessing at it produces rules fitted to a
 * scenario that never recurs.
 *
 * They are still recorded. Only `working()` skips them, because *that you
 * checked a password* is occasionally worth seeing in the audit while never
 * being worth acting on.
 */
export const TRANSIENT = [
  "com.apple.UserNotificationCenter",
  "com.apple.notificationcenterui",
  "com.apple.dock",
  "com.apple.loginwindow",
  "com.apple.ScreenSaver.Engine",
  // You do not work in a password manager. Already title-blind below; this is
  // the other half of the same observation.
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.apple.keychainaccess",
  "com.bitwarden.desktop",
  "com.lastpass.LastPass",
  "com.apple.Passwords",
  "org.keepassxc.keepassxc",
];

/**
 * Applications whose window titles are never recorded.
 *
 * The app itself still is — that you were in a password manager is ordinary and
 * useful; *which vault item you had open* is not something to keep in a SQLite
 * file for eight hours. The list is short and conservative, and errs toward
 * dropping: a title we decline to keep costs a little ranking quality, and a
 * title we should not have kept cannot be un-kept.
 *
 * This is a floor, not a fence. Anything genuinely sensitive should also be in
 * the user's own `contextExclude`.
 */
export const TITLE_BLIND = [
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.apple.keychainaccess",
  "com.bitwarden.desktop",
  "com.lastpass.LastPass",
  "com.apple.Passwords",
  "org.keepassxc.keepassxc",
  "com.apple.Console",
];

export interface ContextInput {
  app?: string | null;
  title?: string | null;
  workspace?: string | null;
  block?: string | null;
}

/**
 * Who is in front, without asking for accessibility.
 *
 * `lsappinfo` talks to the Launch Services database, which already knows the
 * frontmost application because it is what puts it there. The `osascript`
 * route through System Events would need an accessibility grant, and this stack
 * already has three programs competing for that tree — adding a fourth consumer
 * to answer a question Launch Services answers for free is a bad trade.
 *
 * Undocumented, so it is treated as such: any unexpected output is undefined
 * rather than an error, and the caller carries on with whatever it last knew.
 */
export async function frontmostApp(): Promise<{ app: string; title: string | null } | undefined> {
  const { execFile } = await import("node:child_process");
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve) =>
      execFile("/usr/bin/lsappinfo", args, { timeout: 2000 }, (err, out) => resolve(err ? "" : out)),
    );

  const asn = (await run(["front"])).trim();
  if (!asn.startsWith("ASN:")) return undefined;

  // One record rather than a field at a time. `info <asn>` carries everything,
  // and at a poll every two seconds the difference between two subprocesses and
  // three is worth having.
  //
  // The shape, which is not obvious and is not documented anywhere:
  //
  //     "iTerm2" ASN:0x0-0xcf5cf5: (in front)
  //         bundleID="com.googlecode.iterm2"
  //
  // The display name is the *leading quoted token*, not a `name=` pair — that
  // first slot is the name field, and it prints `[ NULL ]` when you asked for
  // something else. Everything after it is `key="value"`.
  const info = await run(["info", asn]);

  const bundle =
    /(?:bundleID|CFBundleIdentifier)"?\s*=\s*"([^"]+)"/.exec(info)?.[1] ??
    // If a future macOS drops it from the full record, ask for it directly
    // rather than reporting the frontmost application as unknown.
    /(?:bundleID|CFBundleIdentifier)"?\s*=\s*"([^"]+)"/.exec(await run(["info", "-only", "bundleID", asn]))?.[1];
  if (!bundle) return undefined;

  const named = /^\s*"([^"]+)"/.exec(info)?.[1];
  return { app: bundle, title: named && named !== "[ NULL ]" ? named : null };
}

/**
 * Ask the window manager what is focused, and where.
 *
 * Preferred over `frontmostApp` because it answers all three questions at once
 * — application, window title and workspace — and because it *establishes*
 * state rather than waiting for a transition. That distinction is the whole
 * reason this exists: Rift's `workspace_changed` subscription is a foreground
 * process that dies with its terminal, and it only fires on change, so nothing
 * ever re-announced the workspace you were already sitting in. A poll has
 * neither problem and needs no wiring to survive a reboot.
 *
 * Talaria reading Rift is a sensor being read, which is fine. Rift reading
 * Hermes would be the thing this project does not do.
 *
 * Rift only knows about windows it manages, so this can legitimately answer
 * nothing — an unmanaged space, a floating panel, Rift not running at all.
 * `frontmostApp` covers those.
 */
export async function frontmostFromRift(cliPath?: string): Promise<
  { app: string; title: string | null; workspace: string | null } | undefined
> {
  const { execFile } = await import("node:child_process");
  const candidates = cliPath
    ? [cliPath]
    : ["/opt/homebrew/bin/rift-cli", "/usr/local/bin/rift-cli", `${process.env.HOME}/.cargo/bin/rift-cli`, `${process.env.HOME}/.local/bin/rift-cli`];

  for (const bin of candidates) {
    const out = await new Promise<string>((resolve) =>
      execFile(bin, ["query", "workspaces"], { timeout: 2000 }, (err, stdout) =>
        resolve(err ? "" : stdout),
      ),
    );
    if (!out.trim()) continue;

    try {
      const spaces = JSON.parse(out) as {
        is_active?: boolean;
        name?: string;
        windows?: { is_focused?: boolean; bundle_id?: string; title?: string }[];
      }[];
      const active = spaces.find((s) => s.is_active);
      if (!active) return undefined;
      const win = active.windows?.find((w) => w.is_focused);
      if (!win?.bundle_id) {
        // A workspace is active but nothing in it is focused — a floating panel,
        // or focus sitting on something Rift does not manage. The workspace is
        // still true and still worth having.
        return { app: "", title: null, workspace: active.name ?? null };
      }
      return {
        app: win.bundle_id,
        title: win.title?.trim() || null,
        workspace: active.name ?? null,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Recording can be switched off, and the switch has to survive a restart. */
const OFF_KEY = "context.off";

/** So must the workspace — see `rememberWorkspace`. */
const WORKSPACE_KEY = "context.workspace";

export class ContextRecord {
  constructor(
    private mirror: Mirror,
    /** Extra bundle ids the user never wants recorded at all. */
    private exclude: string[] = [],
  ) {}

  get recording(): boolean {
    return this.mirror.get(OFF_KEY) !== "1";
  }

  /**
   * Stop, and empty the drawer.
   *
   * An off switch that stops future writes and leaves the last eight hours
   * sitting there is not an off switch. Returns how many rows went, so the
   * person turning it off can see that something actually happened.
   */
  stop(): number {
    this.mirror.set(OFF_KEY, "1");
    return this.mirror.forgetContext();
  }

  start(): void {
    this.mirror.set(OFF_KEY, null);
  }

  /**
   * Record a moment, subject to policy.
   *
   * Returns what was actually written, so a caller can see the redaction rather
   * than trust it — `talaria context set` prints this back.
   */
  note(input: ContextInput): { recorded: boolean; row?: ContextRow; why?: string } {
    if (!this.recording) return { recorded: false, why: "recording is off" };

    const app = input.app?.trim() || null;
    if (app && this.exclude.includes(app)) {
      return { recorded: false, why: `${app} is excluded` };
    }

    // The app survives, the title does not. Knowing you were in a password
    // manager is ordinary; knowing which entry you had open is not.
    const blind = app !== null && TITLE_BLIND.includes(app);
    const row: ContextRow = {
      at: new Date().toISOString(),
      app,
      title: blind ? null : input.title?.trim() || null,
      workspace: input.workspace?.trim() || null,
      block: input.block?.trim() || null,
    };

    this.mirror.noteContext(row);
    this.mirror.pruneContext(new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString());
    return { recorded: true, row, ...(blind ? { why: "title withheld for that app" } : {}) };
  }

  /** The most recent moment that was not a launcher. What the picker asks for. */
  working(): ContextRow | null {
    if (!this.recording) return null;
    return this.mirror.workingContext([...LAUNCHERS, ...TRANSIENT, ...this.exclude]);
  }

  /** Everything held, for the audit. `talaria context` prints this. */
  recent(limit = 50): ContextRow[] {
    return this.mirror.recentContext(limit);
  }

  /**
   * The last workspace anybody told us about.
   *
   * Rift knows this and the poll does not, so the two halves of a context row
   * arrive from different places at different times. Carrying the workspace
   * forward is what stops a poll two seconds after a workspace switch from
   * writing a row that says the workspace is unknown — which would then be the
   * newest row, and therefore the answer.
   *
   * **Stored rather than held in memory.** It lived on this object once, and a
   * restart lost it: every row written between the daemon coming back and the
   * next workspace *change* carried no workspace at all. On a machine where you
   * stay in one workspace all morning, that is the whole morning — and after a
   * reboot it is every row until you happen to switch. The signal that survives
   * a restart badly is the one that goes missing exactly when nobody is looking.
   *
   * It can still be stale: the workspace may have moved while the daemon was
   * down. Stale-and-corrected-on-the-next-switch beats absent, because absent
   * looks identical to "this machine has no workspaces".
   */
  rememberWorkspace(name: string | null): void {
    if (name) this.mirror.set(WORKSPACE_KEY, name);
  }

  get workspace(): string | null {
    return this.mirror.get(WORKSPACE_KEY);
  }
}

/**
 * Watch what is in front.
 *
 * A poll rather than a subscription, because nothing on this machine offers the
 * event. Rift emits `workspace_changed`, `windows_changed`,
 * `window_title_changed` and `stacks_changed` — all of which describe windows
 * and workspaces, and none of which is focus. Tabbing between two applications
 * produces no Rift event at all, which was measured rather than assumed.
 *
 * Two seconds misses anything shorter than two seconds. For this purpose that is
 * a feature: a glance at a calculator is not a change of what you are working
 * on, and the record is meant to answer "what were you doing" rather than
 * "what did the window server do".
 *
 * Lives in the daemon rather than in BetterTouchTool on purpose. BTT is a fine
 * surface and a bad place to keep logic that everything else depends on, and
 * "does the context record work at all" is that kind of logic.
 */
export class FrontmostWatcher {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private record: ContextRecord,
    private everyMs = 2000,
    /** Where `rift-cli` lives, when it is not somewhere obvious. */
    private riftCli?: string,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    // Never hold the process open. The daemon's reason to live is the socket.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.record.recording) return;
    try {
      // The window manager first: it answers application, title and workspace
      // together, and it is the only thing here that knows about workspaces at
      // all. Falling back to Launch Services covers an unmanaged space, a
      // floating panel, or Rift not running.
      const rift = await frontmostFromRift(this.riftCli);
      if (rift?.workspace) this.record.rememberWorkspace(rift.workspace);

      if (rift?.app) {
        this.record.note({ app: rift.app, title: rift.title, workspace: rift.workspace });
        return;
      }

      const front = await frontmostApp();
      if (!front) return;
      // Launch Services has no window title to give, so this records the
      // application's display name instead — less informative, and much less
      // revealing.
      this.record.note({ app: front.app, title: front.title, workspace: this.record.workspace });
    } catch {
      // A poll that fails is a poll. It will run again in two seconds.
    }
  }
}
