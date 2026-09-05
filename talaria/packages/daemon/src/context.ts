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
/**
 * Whether the two things that answer "what is in front" can exist here.
 *
 * `lsappinfo` and AeroSpace are both macOS, and both are polled on a timer, so
 * off macOS they are not a failure to handle but a question not to ask. What
 * replaces them is KWin, which is compositor work and is not this change.
 *
 * Named for the sources rather than for the platform because that is the fact
 * being tested. When KWin lands, this constant does not become wrong — it stops
 * being the only thing consulted, and the flag beside it says so.
 */
const MACOS_WINDOW_SOURCES = process.platform === "darwin";

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

/**
 * Applications whose window titles are kept only if they name something in the
 * library.
 *
 * The middle ground between recording a title and refusing to look at it, and
 * the more interesting rule. A window title from Messages is the name of the
 * person you are talking to — which is one of the strongest retrieval signals
 * on the machine, because Hermes has People and that name resolves to a block
 * and through it to every note and task touching them.
 *
 * It is also, stored as text, a timestamped log of who you talk to and when.
 *
 * Both are true, and they are not in tension, because *the value is in the
 * resolution rather than in the string*. Look the title up: a hit becomes a
 * block id, which ranks better than the name ever could since an id is
 * unambiguous where a name is fuzzy. A miss is dropped, because the name of
 * somebody who is not in your library has almost no retrieval value and carries
 * the whole of the cost.
 *
 * The rule generalises past Messages — any title that names a block is more
 * useful as a reference than as text — but it is applied only to the apps
 * where the title is personal, because everywhere else the raw text is worth
 * having on its own.
 */
export const TITLE_IF_KNOWN = [
  "com.apple.MobileSMS",
  "com.apple.iChat",
  "com.apple.mail",
  "com.tinyspeck.slackmacgap",
  "com.facebook.archon", // Messenger
  "net.whatsapp.WhatsApp",
  "ru.keepcoder.Telegram",
  "com.hnc.Discord",
  "us.zoom.xos",
];

/**
 * Applications whose `title` has been *verified* to be a window title.
 *
 * An allowlist, and it is an allowlist because the blocklist that preceded it
 * failed on its first day in the worst possible way.
 *
 * The window manager's `title` is not a window title. It is the accessibility
 * title of whatever the window exposes as focused, and in a browser showing
 * Gmail that is the message pane — so "title" arrived as the **entire body of an
 * email**, complete with colleagues' names, addresses, direct phone numbers,
 * budget codes and forwarded threads from people who have no idea this software
 * exists. Third-party correspondence, verbatim, on disk.
 *
 * The design that allowed it recorded every title and dropped the ones from apps
 * somebody had thought to flag. That requires anticipating every application
 * whose title field misbehaves, in advance, and being right every time. It was
 * wrong about the commonest application on the machine.
 *
 * So the default is now *do not record*, and an application earns its way onto
 * this list by having been looked at. The cost is real — most of a day happens
 * in a browser and browsers are not here — but the signal there was never worth
 * much anyway: `Formatting options` and `Send and archive (⌘Enter)` are focus
 * artifacts, not subjects.
 */
export const TITLE_TRUSTED = [
  "com.googlecode.iterm2",
  "com.apple.Terminal",
  "com.apple.finder",
  "com.apple.TextEdit",
  "com.apple.Preview",
  "com.apple.dt.Xcode",
  "com.microsoft.VSCode",
  "com.todesktop.230313mzl4w4u92",
  "md.obsidian",
  "com.microsoft.Excel",
  "com.microsoft.Word",
  "com.apple.iWork.Pages",
  "com.apple.iWork.Numbers",
  "com.apple.iWork.Keynote",
];

/**
 * A backstop for the allowlist being wrong again.
 *
 * A window title is short. Anything past this is definitionally not one, and is
 * far more likely to be a document's contents — which is exactly the shape the
 * failure took. Applied to every application including trusted ones, because the
 * whole lesson here is that a list of apps somebody vetted is not a guarantee.
 */
export const MAX_TITLE = 120;

/**
 * How long to go on assuming the window manager is not there.
 *
 * Long enough that a machine without it stops paying for the question, short
 * enough that starting it is noticed within a coffee.
 */
export const WM_RECHECK_MS = 5 * 60 * 1000;

/**
 * Decoration a window manager hangs on a title, which is not part of the title.
 *
 * iTerm2 puts a bell on a tab whose session received one — a command that
 * finished with a beep, a shell error — so the same shell window is called
 * `-zsh` for most of an afternoon and `-zsh 🔔` for the ten seconds after a
 * `printf '\a'`. Recorded faithfully, that is two titles for one window, and
 * the column exists to answer "what was I working in" rather than "was anything
 * beeping at 1:47".
 *
 * Stripped rather than tolerated because this record is derived and used for
 * ranking and scoping: the moment anything groups by title, `-zsh` and
 * `-zsh 🔔` quietly become two different places to have been.
 *
 * Deliberately a small, named list rather than a general emoji strip. An emoji
 * in a window title is usually somebody's own — a document called `📌 Q3` is
 * named that — and a rule that ate those would be losing real signal to tidy up
 * a notification badge.
 */
export const TITLE_MARKERS = ["\u{1F514}", "\u{1F515}", "\u{25CF}", "\u{2022}"];

/**
 * A title as the window is called, without what was blinking at the time.
 *
 * Markers are taken from either end and the result re-trimmed, because a
 * stripped marker leaves the space that separated it. A title that was *only* a
 * marker becomes nothing, which is correct: it never named anything.
 */
export function stripMarkers(title: string): string {
  let out = title.trim();
  let again = true;
  while (again) {
    again = false;
    for (const m of TITLE_MARKERS) {
      if (out.startsWith(m)) {
        out = out.slice(m.length).trim();
        again = true;
      }
      if (out.endsWith(m)) {
        out = out.slice(0, -m.length).trim();
        again = true;
      }
    }
  }
  return out;
}

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
  // Launch Services is macOS, and there is no equivalent here yet — the Linux
  // answer is KWin, and it belongs with the rest of the compositor work rather
  // than smuggled in under a function named after a macOS database.
  //
  // Guarded at the source rather than left to fail. `execFile` on a path that
  // does not exist is a spawn, an error and a rejected promise, and this runs
  // every two seconds forever: precisely the shape this codebase already
  // learned to stop doing with the AeroSpace candidate list below.
  if (!MACOS_WINDOW_SOURCES) return undefined;
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
 * state rather than waiting for a transition. That distinction is why this
 * exists at all: an event subscription only fires on change, so nothing ever
 * re-announces the workspace you were already sitting in. A poll has neither
 * problem and needs no wiring to survive a reboot.
 *
 * Talaria reading a window manager is a sensor being read, which is fine. A
 * window manager reading Hermes would be the thing this project does not do.
 *
 * AeroSpace answers a formatted query, so one call carries everything and there
 * is no tree to walk. That is the whole of the difference from the Rift version
 * this replaces, which fetched every workspace, found the active one, then
 * found the focused window inside it — and returned an empty title for Chrome
 * and several other applications, which is why window titles moved to an
 * accessibility read in the app and stayed there.
 *
 * It can still legitimately answer nothing: a workspace with no windows in it,
 * or AeroSpace not running at all. `frontmostApp` covers those.
 */
export async function frontmostFromAerospace(cliPath?: string): Promise<
  { app: string; title: string | null; workspace: string | null } | undefined
> {
  if (!MACOS_WINDOW_SOURCES) return undefined;
  const { execFile } = await import("node:child_process");
  const candidates = aerospaceCandidates(cliPath);

  const run = (bin: string, args: string[]): Promise<string> =>
    new Promise((resolve) =>
      execFile(bin, args, { timeout: 2000 }, (err, stdout) => resolve(err ? "" : stdout)),
    );

  for (const bin of candidates) {
    // Tab-separated rather than JSON: `--json` omits the bundle id and the
    // workspace, and a format string is the documented way to ask for exactly
    // the fields you want.
    const line = (
      await run(bin, [
        "list-windows",
        "--focused",
        "--format",
        "%{app-bundle-id}\t%{workspace}\t%{window-title}",
      ])
    ).trim();

    if (line) {
      // Split twice and keep the remainder whole: a window title may contain a
      // tab, and losing everything after one would be a silent truncation of
      // the one field most likely to carry it.
      const first = line.indexOf("\t");
      const second = line.indexOf("\t", first + 1);
      if (first > 0 && second > first) {
        const app = line.slice(0, first);
        const workspace = line.slice(first + 1, second).trim();
        const title = line.slice(second + 1).trim();
        return { app, title: title || null, workspace: workspace || null };
      }
    }

    // A workspace can be active with nothing focused in it — an empty one, or
    // focus resting on something AeroSpace does not manage. The workspace is
    // still true and still worth having.
    const ws = (await run(bin, ["list-workspaces", "--focused"])).trim();
    if (ws) return { app: "", title: null, workspace: ws };

    // This binary answered nothing at all for either question, which is what an
    // absent or stopped AeroSpace looks like. Try the next path.
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
    /**
     * Whether every application's title may be recorded.
     *
     * `TITLE_TRUSTED` is a curated list of macOS bundle ids and matches no
     * window class, so on Linux it drops every title — correct as a default and
     * wrong as a permanent answer for somebody who has looked at their own
     * machine and decided. `contextTrustAllTitles` is that decision.
     */
    private trustAllTitles: boolean = false,
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

    // Before anything else looks at it, so every rule below — the length
    // backstop, the block lookup — sees the title rather than the badge.
    let title = (input.title ? stripMarkers(input.title) : "") || null;
    let block = input.block?.trim() || null;
    let why: string | undefined;

    if (title && title.length > MAX_TITLE) {
      // Not a title. Almost certainly a document's contents.
      title = null;
      why = "that was too long to be a window title, so it was dropped";
    } else if (app && TITLE_BLIND.includes(app)) {
      // Belt and braces now that the default is to record nothing: a password
      // manager must never slip through by being added to the trusted list by
      // somebody who did not think about it.
      title = null;
      why = "title withheld for that app";
    } else if (app && title && TITLE_IF_KNOWN.includes(app)) {
      // Resolve, then drop. A hit keeps the whole signal in a better form; a
      // miss keeps nothing, which is the right trade for a name that leads
      // nowhere.
      const hit = this.mirror.blockTitled(title);
      title = null;
      if (hit) {
        block = block ?? hit;
        why = "title resolved to a block";
      } else {
        why = "title named nothing in the library, so it was dropped";
      }
    } else if (app && title && this.trustAllTitles) {
      // Everything vetted at once, by a person who said so.
      //
      // `TITLE_TRUSTED` is a curated list of macOS bundle ids and matches no
      // window class, so on Linux every title was being dropped and the record
      // kept an application name and a workspace. That is the right default —
      // it is what the Mac does for an application nobody has checked — but it
      // is a default, and somebody who has looked at their own machine and
      // decided is entitled to say so.
      //
      // Off unless `contextTrustAllTitles` is set, so a config nobody has
      // touched behaves exactly as it did. The blindlist is untouched by this
      // and always applies first: trusting every application is not the same
      // as trusting a password manager, and that distinction is the whole
      // reason the two lists are separate.
      why = "titles are trusted on this machine";
    } else if (app && title && !TITLE_TRUSTED.includes(app)) {
      // The default, and the point of the rewrite. An application nobody has
      // checked contributes its name and its workspace and nothing else.
      title = null;
      why = `${app} is not on the verified-title list, so the title was dropped`;
    } else if (app && title && this.isAppName(app, title)) {
      // Some paths can only report the application's own display name, which
      // says nothing the `app` column does not already say. Dropping it keeps
      // the record honest about how much subject it actually holds.
      title = null;
    }

    const row: ContextRow = {
      at: new Date().toISOString(),
      app,
      title,
      // The stored workspace when the caller did not name one. Only the poll
      // knows it first-hand; anything else calling `note()` — a manual
      // `context set`, a capture, whatever comes later — would otherwise write a
      // row with the workspace missing, and that row is then the newest one and
      // therefore the answer.
      workspace: input.workspace?.trim() || this.workspace,
      block,
    };

    this.mirror.noteContext(row);
    this.mirror.pruneContext(new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString());
    return { recorded: true, row, ...(why ? { why } : {}) };
  }

  /**
   * Is this "title" just the application's name again?
   *
   * The Launch Services fallback has no window title to give and reports the
   * display name instead, so a row reads `Google Chrome · Google Chrome`. That
   * is not a subject, and leaving it in makes the record look like it holds one.
   */
  private isAppName(app: string, title: string): boolean {
    const tail = app.split(".").pop()?.toLowerCase() ?? "";
    const t = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    return t.length > 0 && (tail.replace(/[^a-z0-9]/g, "") === t || tail.includes(t) || t.includes(tail));
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
   * The window manager knows this and the poll does not, so the two halves of a
   * context row
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

  /**
   * Stop claiming a workspace.
   *
   * The remembered one is a guess that survives a restart, which is right while
   * something is still answering for it. When nothing is — the window manager
   * has been quit, or was never installed — the guess stops being stale and
   * becomes false: every row would go on being stamped with the last workspace
   * anybody saw, indefinitely, in a record whose whole contract is that it
   * decays. It is the only field here that can quietly assert something untrue.
   */
  forgetWorkspace(): void {
    this.mirror.set(WORKSPACE_KEY, null);
  }

  get workspace(): string | null {
    return this.mirror.get(WORKSPACE_KEY);
  }
}

/**
 * Watch what is in front.
 *
 * A poll rather than a subscription, because nothing on this machine offers the
 * event. Measured against Rift, whose four events — `workspace_changed`,
 * `windows_changed`, `window_title_changed`, `stacks_changed` — all describe
 * windows and workspaces and none of which is focus: tabbing between two
 * applications produced no event at all.
 *
 * The finding outlived the window manager it was made against. AeroSpace has
 * `on-focus-changed`, which would remove the need for a poll here — worth
 * doing, and a bigger change than swapping the reader, because a callback is
 * configured in AeroSpace's own file rather than in ours and the two would have
 * to be installed together.
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
  /**
   * Whether the window manager answered last time, and when we last asked.
   *
   * `frontmostFromAerospace` tries several candidate paths, so a machine with
   * no window manager spawned a process per path that missed, every two
   * seconds, forever — a poll that had already learned its answer and asked
   * again anyway. Now it asks again on a slow timer instead, because one may be
   * installed or started at any point and a daemon that decided once would
   * never notice.
   */
  private wmAnswered = true;
  private wmCheckedAt = 0;

  constructor(
    private record: ContextRecord,
    private everyMs = 2000,
    /** Where `aerospace` lives, when it is not somewhere obvious. */
    private aerospaceCli?: string,
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
      // floating panel, or AeroSpace not running.
      // Skipped entirely once it is known to be absent, and retried on the
      // slow timer so installing or starting it is still noticed.
      const askWm = this.wmAnswered || Date.now() - this.wmCheckedAt > WM_RECHECK_MS;
      const wm = askWm ? await frontmostFromAerospace(this.aerospaceCli) : undefined;
      if (askWm) {
        this.wmCheckedAt = Date.now();
        this.wmAnswered = wm !== undefined;
      }

      if (wm?.workspace) this.record.rememberWorkspace(wm.workspace);
      // Nothing is answering for workspaces, so stop claiming one. A stale
      // guess is worth keeping while its source is alive; once it is not, the
      // guess is simply wrong and says so to everything downstream.
      if (askWm && wm === undefined) this.record.forgetWorkspace();

      if (wm?.app) {
        this.record.note({ app: wm.app, title: wm.title, workspace: wm.workspace });
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

/**
 * Where the aerospace binary is, tried in the usual places.
 *
 * Shared with `frontmostFromAerospace`, which had this list inline first. A
 * second copy would have been a second thing to update the day somebody
 * installs it somewhere new — and the copy had in fact already drifted out of
 * reach of this comment, so `frontmostFromAerospace` now calls this rather than
 * repeating it.
 *
 * Empty off macOS, which makes every loop over it a loop that does not run.
 * AeroSpace is a macOS tiling manager; an explicit `aerospaceCli` pointing at
 * something on a Linux box would be a person configuring a binary that cannot
 * be there, so the override does not rescue it either.
 */
export function aerospaceCandidates(cliPath?: string): string[] {
  if (!MACOS_WINDOW_SOURCES) return [];
  return cliPath
    ? [cliPath]
    : [
        "/opt/homebrew/bin/aerospace",
        "/usr/local/bin/aerospace",
        `${process.env.HOME}/.local/bin/aerospace`,
      ];
}

export interface WorkspaceWindow {
  id: number;
  app: string;
  bundleId: string | null;
  title: string;
}

export interface WorkspaceSummary {
  name: string;
  focused: boolean;
  windows: WorkspaceWindow[];
}

/**
 * Every workspace, and what is in it.
 *
 * Windows are listed with their ids because that is what a thumbnail is taken
 * of: a window parked off-screen by a tiling manager still has a backing store,
 * so it can be captured without being shown — which is the whole reason a
 * picture of a workspace you are not looking at is possible at all.
 *
 * Empty workspaces are kept. A workspace with nothing in it is still somewhere
 * to go, and leaving it out of the list would make the one place you want to
 * move a window *to* the one place you cannot click.
 */
export async function workspaces(cliPath?: string): Promise<WorkspaceSummary[]> {
  const { execFile } = await import("node:child_process");
  const run = (bin: string, args: string[]): Promise<string> =>
    new Promise((resolve) =>
      execFile(bin, args, { timeout: 3000, maxBuffer: 1 << 20 }, (err, stdout) =>
        resolve(err ? "" : stdout),
      ),
    );

  for (const bin of aerospaceCandidates(cliPath)) {
    const names = (await run(bin, ["list-workspaces", "--all"]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) continue;

    const focused = (await run(bin, ["list-workspaces", "--focused"])).trim();
    // One call for every window rather than one per workspace: the format
    // carries which workspace each is in, and a shell round trip per workspace
    // is latency nobody needs on a panel that opens under a hotkey.
    const rows = (
      await run(bin, [
        "list-windows",
        "--all",
        "--format",
        "%{workspace}\t%{window-id}\t%{app-bundle-id}\t%{app-name}\t%{window-title}",
      ])
    )
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length >= 5);

    const byWorkspace = new Map<string, WorkspaceWindow[]>();
    for (const [ws, id, bundleId, app, ...rest] of rows) {
      const n = Number(id);
      if (!Number.isFinite(n)) continue;
      const list = byWorkspace.get(ws!) ?? [];
      // The remainder joined back up: a window title may contain a tab, and
      // taking only the fifth field would truncate exactly the string most
      // likely to have one in it.
      list.push({ id: n, app: app ?? "", bundleId: bundleId || null, title: rest.join("\t") });
      byWorkspace.set(ws!, list);
    }

    return names.map((name) => ({
      name,
      focused: name === focused,
      windows: byWorkspace.get(name) ?? [],
    }));
  }
  return [];
}

/** Go to a workspace. Returns whether the manager accepted it. */
export async function focusWorkspace(name: string, cliPath?: string): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  for (const bin of aerospaceCandidates(cliPath)) {
    const ok = await new Promise<boolean>((resolve) =>
      execFile(bin, ["workspace", name], { timeout: 3000 }, (err) => resolve(!err)),
    );
    if (ok) return true;
  }
  return false;
}
