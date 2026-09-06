import type { CanonicalBlock } from "@talaria/canonical";

/**
 * A link to a block, in the shape the destination wants.
 *
 * The reciprocal of capture. Capture turns text into a block; this turns a block
 * into text, so the library can be referenced from inside whatever application
 * somebody is writing in. Most of the graph in a knowledge base lives in prose
 * rather than in fields, and today that is only true of prose written *inside*
 * Hermes — every sentence typed into Mail or an editor is disconnected by
 * default, because connecting it means going and finding a URL.
 *
 * Pure on purpose: block in, string out. Nothing here touches the network, the
 * clipboard, or the frontmost application.
 */

/** How the link is written. */
export type Syntax = "markdown" | "wiki" | "bare" | "title";

/**
 * Which of a block's two addresses to use.
 *
 * `share` is the https link: it names a host, works for anyone on any device
 * with nothing installed, and dies the day Hermes moves. `here` is
 * `talaria://`, resolved at click time out of the one config file that knows
 * where Hermes lives, so it survives the move — and means nothing at all to
 * anyone you send it to.
 *
 * The choice is therefore about the *reader*, not about durability in the
 * abstract: something you are writing to yourself wants `here`, something
 * leaving the machine wants `share`.
 */
export type Address = "share" | "here";

export interface LinkStyle {
  syntax: Syntax;
  address: Address;
}

export const SYNTAXES: Syntax[] = ["markdown", "wiki", "bare", "title"];
export const ADDRESSES: Address[] = ["share", "here"];

/** Brackets in a title would otherwise close the link early. */
const escapeMarkdown = (s: string): string => s.replace(/([[\]])/g, "\\$1");

export function render(block: CanonicalBlock, style: LinkStyle): string {
  const href = style.address === "here" ? block.appUrl : block.url;
  switch (style.syntax) {
    case "markdown":
      return `[${escapeMarkdown(block.title)}](${href})`;
    // A wikilink carries no address at all — it resolves by title, in whatever
    // is reading it. That makes it the one syntax where `address` is moot, and
    // the one that can silently point at nothing. Offered because Hermes'
    // Markdown export already writes connections this way, so a wikilink pasted
    // into that vault lands on the right file.
    case "wiki":
      return `[[${block.title}]]`;
    case "bare":
      return href;
    case "title":
      return block.title;
  }
}

/**
 * What a given application wants.
 *
 * Deliberately short. A long table of bundle ids is a maintenance burden that
 * pretends to knowledge it does not have; these are the cases where getting it
 * wrong is actively annoying, and everything else takes the default.
 *
 * Markdown appears only where markdown is either rendered or being authored.
 * Pasting `[Title](https://…)` into Mail produces literal brackets in an email,
 * which is worse than a bare URL — and a bare URL autolinks there anyway.
 */
const BY_APP: Record<string, LinkStyle> = {
  // Writing to yourself: the durable address, in the syntax you are already in.
  "md.obsidian": { syntax: "markdown", address: "here" },
  "com.microsoft.VSCode": { syntax: "markdown", address: "here" },
  "com.todesktop.230313mzl4w4u92": { syntax: "markdown", address: "here" }, // Cursor
  "com.apple.dt.Xcode": { syntax: "bare", address: "here" },
  "com.apple.Notes": { syntax: "bare", address: "here" },
  "com.apple.Terminal": { syntax: "bare", address: "here" },
  "com.googlecode.iterm2": { syntax: "bare", address: "here" },

  // Leaving the machine: the address that works on somebody else's.
  "com.apple.mail": { syntax: "bare", address: "share" },
  "com.apple.MobileSMS": { syntax: "bare", address: "share" },
  "com.tinyspeck.slackmacgap": { syntax: "bare", address: "share" },
  "com.google.Chrome": { syntax: "bare", address: "share" },
  "com.apple.Safari": { syntax: "bare", address: "share" },
};

/**
 * The default when the application is unknown, or unknowable.
 *
 * `share` rather than `here`, because the two failures are not the same size. A
 * durable link that means nothing to the person you sent it to is a link that
 * quietly does not work, discovered by them and not by you. An https link that
 * outlives its host is a link that breaks visibly, later, for everyone at once.
 * Prefer the visible failure.
 */
export const DEFAULT_STYLE: LinkStyle = { syntax: "bare", address: "share" };

/**
 * Launchers are never the answer to "what am I writing in".
 *
 * By the time a picker is on screen it *is* the frontmost application, so
 * asking the system at that moment returns the picker. Detection has to happen
 * before the picker opens — which is why `--for` exists, and why the caller that
 * knows (a hotkey handler firing on the way in) should always pass it.
 */
const LAUNCHERS = new Set([
  "com.runningwithcrayons.Alfred",
  "com.raycast.macos",
  "com.apple.Spotlight",
  "com.hegenberg.BetterTouchTool",
  "com.stairways.keyboardmaestro.engine",
]);

/**
 * The same table, for a desktop that names its applications differently.
 *
 * A window class is what X and Wayland call an application, and it is what KWin
 * reports — so it is this platform's bundle id, and it belongs in the same
 * table rather than in a second copy of this file. The keys are lowercased on
 * the way in because a window class is `Code`, `code` or `code-oss` depending on
 * how it was packaged, and none of those distinctions mean anything here.
 *
 * Kept as short as the other one, for the same reason: a long table pretends to
 * knowledge it does not have, and everything absent takes the default.
 */
const BY_WINDOW_CLASS: Record<string, LinkStyle> = {
  // Writing to yourself, in something that renders or authors markdown.
  obsidian: { syntax: "markdown", address: "here" },
  code: { syntax: "markdown", address: "here" },
  "code-oss": { syntax: "markdown", address: "here" },
  vscodium: { syntax: "markdown", address: "here" },
  cursor: { syntax: "markdown", address: "here" },
  logseq: { syntax: "markdown", address: "here" },
  zettlr: { syntax: "markdown", address: "here" },
  ghostwriter: { syntax: "markdown", address: "here" },
  // A terminal takes a bare address and would show brackets as brackets.
  konsole: { syntax: "bare", address: "here" },
  alacritty: { syntax: "bare", address: "here" },
  kitty: { syntax: "bare", address: "here" },
  "org.wezfurlong.wezterm": { syntax: "bare", address: "here" },
  "gnome-terminal-server": { syntax: "bare", address: "here" },
  kate: { syntax: "markdown", address: "here" },
  kwrite: { syntax: "bare", address: "here" },
  // Leaving the machine: an address that works on somebody else's.
  thunderbird: { syntax: "bare", address: "share" },
  evolution: { syntax: "bare", address: "share" },
  "org.kde.kmail2": { syntax: "bare", address: "share" },
  slack: { syntax: "bare", address: "share" },
  element: { syntax: "bare", address: "share" },
  signal: { syntax: "bare", address: "share" },
  firefox: { syntax: "bare", address: "share" },
  chromium: { syntax: "bare", address: "share" },
  "google-chrome": { syntax: "bare", address: "share" },
};

/** Launchers, here as there — including Talaria's own picker. */
const LAUNCHER_CLASSES = new Set(["krunner", "plasmashell", "rofi", "wofi", "ulauncher"]);

/**
 * What to write, given whatever the system calls the application in front.
 *
 * One function for both worlds: a bundle id on macOS, a window class on Linux.
 * The caller does not have to know which it holds, which matters because the
 * daemon serves both and the context record stores whichever its platform
 * reported.
 */
export function styleFor(app: string | undefined): LinkStyle {
  if (!app) return DEFAULT_STYLE;
  if (LAUNCHERS.has(app)) return DEFAULT_STYLE;
  const cls = app.toLowerCase();
  if (LAUNCHER_CLASSES.has(cls)) return DEFAULT_STYLE;
  // A window class never looks like a bundle id and vice versa, so asking both
  // costs nothing and saves the caller a platform test.
  return BY_APP[app] ?? BY_WINDOW_CLASS[cls] ?? DEFAULT_STYLE;
}

/**
 * Ask the system what is in front.
 *
 * Best effort by design: this needs accessibility permission, and the answer is
 * wrong whenever a launcher is showing. It returns undefined rather than
 * throwing, so a missing permission degrades to the default style instead of
 * failing a command whose real job is to produce a string.
 */
export async function frontmostBundleId(): Promise<string | undefined> {
  // Off macOS there is nothing to ask yet, and the styles this picks between are
  // keyed by bundle id anyway — so even a perfect Linux answer would be a window
  // class that `BY_APP` has never heard of. Returning undefined lands on
  // `DEFAULT_STYLE`, which is where that lookup would have landed regardless.
  if (process.platform !== "darwin") return undefined;
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      [
        "-e",
        'tell application "System Events" to get bundle identifier of first application process whose frontmost is true',
      ],
      { timeout: 2000 },
      (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined),
    );
  });
}
