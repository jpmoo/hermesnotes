/**
 * Put a string on the clipboard, on whichever platform this is.
 *
 * A module rather than four lines at the one call site, because the Linux front
 * end binds CLI commands to hotkeys and "copy that" is going to be several of
 * them.
 *
 * Every backend here is a subprocess reading stdin. That is not a coincidence
 * worth abstracting away — it is why the platform difference is one array and
 * not one interface.
 */

/** What to run, in the order worth trying, for this session. */
function backends(): string[][] {
  if (process.platform === "darwin") return [["/usr/bin/pbcopy"]];

  // Wayland first when the session says Wayland, and X11 first when it says
  // X11 — but both are always tried. XWayland means `xclip` often works inside
  // a Wayland session, and a bare `XDG_SESSION_TYPE` is not reliable enough to
  // be the only vote when the fallback costs one failed spawn.
  const wayland = ["wl-copy"];
  const x11 = ["xclip", "-selection", "clipboard"];
  const xsel = ["xsel", "--clipboard", "--input"];
  return process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland"
    ? [wayland, x11, xsel]
    : [x11, xsel, wayland];
}

/**
 * Returns the command that took it, or undefined if nothing here could.
 *
 * Undefined rather than a throw, and it matters at the call site: `--copy` on a
 * machine with no clipboard tool installed should still print the string it
 * built. The command failing is not the command's work failing.
 */
export async function copyToClipboard(text: string): Promise<string | undefined> {
  const { spawn } = await import("node:child_process");
  for (const [bin, ...args] of backends()) {
    const ok = await new Promise<boolean>((resolve) => {
      let child;
      try {
        child = spawn(bin!, args, { stdio: ["pipe", "ignore", "ignore"] });
      } catch {
        return resolve(false);
      }
      // A missing binary arrives as an `error` event, not a throw. Unhandled,
      // it takes the process down — which is how a missing `xclip` would have
      // turned "I could not copy this" into no output at all.
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    });
    if (ok) return bin;
  }
  return undefined;
}
