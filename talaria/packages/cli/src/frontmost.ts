/*
 * Asking the system what is in front.
 *
 * Stayed in the CLI when the rest of `link.ts` moved into `canonical`. The
 * tables and the rendering are arithmetic on a block and belong in the shared
 * package; *this* shells out to the operating system, which a package with no
 * node types has no business doing — and which is a different question on every
 * platform. The daemon does not need it at all: the context record already knows
 * what is in front, from the compositor, without asking anybody.
 */

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
