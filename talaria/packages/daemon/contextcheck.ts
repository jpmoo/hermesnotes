/**
 * A window title, without what was blinking at the time.
 *
 * iTerm2 hangs a bell on a tab that received one, so the same shell window is
 * called `-zsh` all afternoon and `-zsh 🔔` for the ten seconds after something
 * beeped. Recorded faithfully that is two titles for one window — and this
 * record is used for ranking and scoping, so the moment anything groups by
 * title they become two different places to have been.
 *
 *   pnpm --filter @talaria/daemon contextcheck
 */
import { stripMarkers, TITLE_MARKERS } from "./src/context.js";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};
const same = (input: string, want: string) =>
  check(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, stripMarkers(input) === want, JSON.stringify(stripMarkers(input)));

// The case that started it, in both the orders a window manager writes it.
same("-zsh 🔔", "-zsh");
same("🔔 -zsh", "-zsh");
same("-zsh", "-zsh");

// Every marker in the list, and more than one of them.
for (const m of TITLE_MARKERS) same(`build ${m}`, "build");
same("🔔 🔔 build", "build");

// A title that was only ever a badge named nothing, and should end as nothing.
same("🔔", "");

// The line this rule must not cross. An emoji in a title is usually somebody's
// own — a document called "📌 Q3 plan" is named that, and eating it would be
// losing real signal to tidy up a notification badge.
same("📌 Q3 plan", "📌 Q3 plan");
same("Review 🔔 draft", "Review 🔔 draft");
same("jpmoo@home-server: ~/hermesnotes", "jpmoo@home-server: ~/hermesnotes");

// Whitespace left behind by a stripped marker goes with it.
same("  -zsh  🔔  ", "-zsh");

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
