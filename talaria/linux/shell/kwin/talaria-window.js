// What is in front, from the only thing that actually knows.
//
// AT-SPI was tried first and cannot answer this. On this desktop it sees four
// applications out of everything running — GTK toolkit accessibility is off and
// Electron needs a flag — so for most windows it reports nothing at all, which
// for a blindlist is the worst possible answer: not "this is a password
// manager" and not "this is safe", but silence.
//
// KWin knows because KWin decides. `resourceClass` is what the blindlist keys
// on, `pid` is what `/proc/<pid>/exe` confirms it with, and `caption` is rung 7.
//
// **Pushed, not polled.** `windowActivated` fires on change, so there is no
// timer here and nothing asks a question whose answer has not moved. That is
// also why this cannot leak into a log: it speaks to one D-Bus name and prints
// nothing. An earlier probe used `print()` and put a window title into the
// journal, where it would have stayed for as long as the journal keeps
// anything.

function report(window) {
  if (!window) {
    callDBus("dev.talaria.Shell", "/Window", "dev.talaria.Window", "Changed", "", "", 0, "");
    return;
  }
  // Sent as four separate fields rather than a formatted line, because the
  // receiver has to apply the blindlist to the first three *before* it is
  // allowed to look at the fourth. A pre-joined string would have already made
  // that impossible.
  callDBus(
    "dev.talaria.Shell", "/Window", "dev.talaria.Window", "Changed",
    String(window.resourceClass || ""),
    String(window.resourceName || ""),
    Number(window.pid || 0),
    String(window.caption || "")
  );
}

report(workspace.activeWindow);
workspace.windowActivated.connect(report);
