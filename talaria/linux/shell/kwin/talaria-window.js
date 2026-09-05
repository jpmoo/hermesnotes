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

// ---------------------------------------------------------------------------
// Where Talaria's own panels sit, and how they arrive.
//
// **A client cannot place itself on Wayland.** That is not a gap to work
// around, it is the design: the compositor owns geometry. So the placement
// happens here, in a script KWin is running, which is the same reason this file
// exists at all for the focused window.
//
// The alternative was `wlr-layer-shell` — the brief's stated reason for
// choosing KDE — but the only binding is C++ (`libLayerShellQtInterface`), and
// PySide6 cannot reach it without a shim. A KWin script needs no shim and no
// new dependency.
//
// Sliding up rather than appearing is done by moving the window over a handful
// of frames. A panel summoned by a hotkey that simply materializes in the
// middle of the screen is startling; one that rises from the edge reads as
// something being brought up, which is what it is.

var OURS = "dev.talaria.shell";
var MARGIN = 12;      // breathing room above the panel bar
var STEPS = 10;
var INTERVAL = 16;    // roughly a frame

// **The size is set here too, not just the position.**
//
// `QWidget.resize` does not survive on Wayland: asking for 680x380 produced a
// 952x504 window with no size hint anywhere that could explain it, and on
// another run a 960x1080 one. The compositor decides geometry and the client
// asks politely, so this stops asking. Keyed by our own captions, which are the
// only thing distinguishing one panel from another at this level — the window
// class is shared by all of them.
var SIZES = {
  "Talaria — Glance": { width: 720, height: 400 },
  "Talaria — Ask Hermes Notes": { width: 760, height: 480 },
  "Talaria — New Block": { width: 640, height: 520 },
  "Talaria — Hermes Notes Collections": { width: 1100, height: 600 },
};

// The one window that is not a summoned panel.
//
// Hermes is a browser you work *in* — tiled, tabbed, left open — so it keeps
// whatever geometry the user gave it. A comment here previously claimed it was
// excluded by not being a `Tool` window; it is not. KWin reports every one of
// these as `normalWindow`, `Tool` included, so the flag distinguishes nothing
// and the title is what actually separates them.
var NOT_A_PANEL = "Talaria — Hermes Notes";

function place(window) {
  if (!window || String(window.resourceClass) !== OURS) return;
  if (String(window.caption) === NOT_A_PANEL) return;

  // The usable area, which excludes the panel — a window placed against the
  // literal screen edge would sit underneath it.
  var area = workspace.clientArea(KWin.MaximizeArea, window);
  var size = SIZES[String(window.caption)];
  if (!size) return;   // a Talaria window nobody has given a size — leave it be

  // Nine positions, written by the shell into `__PLACEMENT__` from
  // `glancePlacement` in config.json. A script cannot read that file, so the
  // value is substituted when the script is generated — the same arrangement
  // the systemd unit uses for the same reason.
  // Translucency, written in the same way and for the same reason.
  //
  // **Opacity, not frosting.** KWin's blur effect is loaded, but a window has to
  // *ask* for blur and the asking is `KWindowEffects` — a KF6 C++ API with no
  // Python binding. So this is honest translucency: what is behind shows
  // through, unblurred. Calling it frosted would be describing something the
  // desktop is not doing.
  var opacity = Number("__OPACITY__");
  if (opacity > 0 && opacity < 1) window.opacity = opacity;

  var place = String("__PLACEMENT__").split("-");
  var vertical = place[0] || "bottom";
  var horizontal = place[1] || "center";

  var restX =
    horizontal === "left" ? area.x + MARGIN
    : horizontal === "right" ? area.x + area.width - size.width - MARGIN
    : area.x + Math.round((area.width - size.width) / 2);

  var restY =
    vertical === "top" ? area.y + MARGIN
    : vertical === "middle" ? area.y + Math.round((area.height - size.height) / 2)
    : area.y + area.height - size.height - MARGIN;

  // It arrives from the nearest edge, so the movement always reads as coming
  // *in* rather than crossing the screen. A panel resting in the middle rises
  // from the bottom, which is the least surprising of the choices there.
  var startY =
    vertical === "top" ? area.y - size.height
    : area.y + area.height;
  var step = 0;

  var timer = new QTimer();
  timer.interval = INTERVAL;
  timer.repeat = true;
  timer.timeout.connect(function () {
    step += 1;
    var t = step / STEPS;
    // Ease out: fast at first, settling rather than stopping dead.
    var eased = 1 - Math.pow(1 - t, 3);
    var y = Math.round(startY + (restY - startY) * eased);
    window.frameGeometry = { x: restX, y: y, width: size.width, height: size.height };
    if (step >= STEPS) {
      window.frameGeometry = { x: restX, y: restY, width: size.width, height: size.height };
      timer.stop();
      // Once more, a beat later. Something resizes these after they map — the
      // 952x504 above — and the last word should be ours.
      var settle = new QTimer();
      settle.interval = 120;
      settle.repeat = false;
      settle.timeout.connect(function () {
        window.frameGeometry = { x: restX, y: restY, width: size.width, height: size.height };
      });
      settle.start();
    }
  });
  timer.start();
}

workspace.windowAdded.connect(place);
// A panel that was hidden and summoned again is not added, it is shown — and it
// may have been moved in between, so it is placed again rather than left where
// the user last dragged it. That is the right call for something summoned by a
// hotkey and the wrong one for a document window, which is why `hermes` is not
// a normal panel and is excluded by being the only one that is not `Tool`.
workspace.windowActivated.connect(function (w) {
  if (w && String(w.resourceClass) === OURS) place(w);
});
