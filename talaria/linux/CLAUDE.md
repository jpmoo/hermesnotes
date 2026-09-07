# Talaria on Linux

Orientation for a coding agent picking this up on a KDE desktop. **All five
steps below are done.** The daemon runs under systemd; a tray shell holds six
panels and a full-screen desk; hotkeys come through the shortcuts portal; the
canvas is a fork of Hermes' own, editable, with its own tool strip and chat; and
Glance reads the focused window through six of its seven rungs.

What is *not* done is listed at the end, under **Still open**. The largest is not
a Linux problem at all: the format cannot carry an attachment's bytes, so a
picture converted into a block stays on the canvas. That is written up in
`../../pkm-interchange/LIMITS.md`.

Read `../../CLAUDE.md` first (the repo's own orientation), then `../DESIGN.md`
for what Talaria is and why. This file covers only what changes when the
platform does.

## What is being built, and what is not

Talaria on macOS works and is somebody's daily tool. **It is not being ported in
place, and nothing here should touch `../app/`.** This is a second
implementation that shares the parts which are already portable and rebuilds the
parts that cannot be.

| | |
|---|---|
| `../packages/daemon` · `../packages/cli` · `../packages/canonical` | TypeScript. Runs on Linux today, bar the handful of macOS-isms listed below. **Shared — changes here affect the Mac app.** |
| `../app/` | 15,000 lines of Swift/AppKit. Not portable, not to be modified. Read it freely: it is the specification for how everything behaves. |
| `linux/` (here) | The new front end. |

## The shape of it

The daemon is the whole back end and already speaks HTTP over a Unix socket. So
the Linux application is:

- **the daemon**, unchanged in shape
- **a web UI** it serves — canvas first, then board, composer, settings
- **a thin native shell** (WebKitGTK, or Qt WebEngine on KDE) to hold panels that
  must float over other windows
- **compositor integration** for hotkeys, the focused window, and selection

Most of what the Swift app does is a window around a view. Only Glance is
genuinely hard.

## Where to start

In this order. Each step is usable on its own, which is the point — nothing here
needs the step after it to be worth having.

1. ~~**Get the daemon running.**~~ **Done.** `linux/install.sh` writes the user
   unit and finishes by asking `/health` over the socket. It was a handful of
   constants and one thing that was not — see *Making the daemon run here*.
2. ~~**Fork Hermes' canvas.**~~ **Done** — `linux/canvas/`, a vite build whose
   output is served from `shell/ui/canvas/`. The decision below held: the
   component came across unedited in shape, and `src/api.ts` + `src/document.ts`
   are the only place that knows both vocabularies. What needed real work was the
   piece the plan named — a placed block is a title, an icon and a completion
   box read from the mirror, not a live editor. **There is no web server**: the
   scheme handler was always a file server, and a bundle is more files in it.
3. ~~**A shell to hold it.**~~ **Done** — `shell/`, PySide6 on Qt 6. Tray item,
   six panels, a full-screen desk, settings window, and the scheme handler the
   canvas now uses unchanged.
4. ~~**Compositor integration.**~~ **Done.** Hotkeys through the portal — see the
   warning below about the route not taken — and the focused window, its title
   and its workspace pushed from a KWin script, which is what `context.ts` was
   waiting on.
5. ~~**Glance last, and prototype before building.**~~ **Done**, and the
   prototyping was the right call — what the rungs actually returned is in the
   table below, and it changed the order they are tried in. Six of the seven are
   built; rung 5, the browser extension, is not, and what it would buy is one
   application rather than "the browser" — see the table.

Do not start with Glance because it is the interesting problem. Starting there
means weeks before anything runs.

## Decisions already made

**KDE, and the reasoning is not aesthetic.** KWin implements
`wlr-layer-shell`, which GNOME refuses and which is what an always-on-top panel
needs. KDE ships and maintains an X11 session longer than GNOME will, and on X11
the hard part of Glance stops being hard. It implemented the
`org.freedesktop.portal.GlobalShortcuts` portal first. KRunner is the direct
analogue of the Alfred workflow in `../alfred/`. COSMIC was considered and
rejected: its own applications are an AT-SPI blind spot, which is precisely
backwards for a tool that reads other applications.

**Support both sessions.** Glance is already built as a ranked ladder of
fallbacks — that shape absorbs this. Probe once at startup and use what the
session offers. X11 is the easy path and has a shelf life; Wayland is the one
that lasts.

**The canvas is a fork of Hermes', not a rewrite.** `apps/web/src/components/
CanvasView.tsx` is a mature 3,310-line canvas with every hard problem already
solved — bend geometry, snapping, regions, marquee, shapes. It reads a
`Collection` and `members` and writes through `api.patch("/collections/…")`.
**Swap the `api` module and it needs no changes at all.** Talaria's copy gets an
`api` that speaks `canvas.json` over the daemon socket:

| Hermes | `canvas.json` |
|---|---|
| `collection.properties.canvas_notes` | `items` without a `blockId` |
| members, geometry in `member.context` | `items` with a `blockId` |
| `collection.properties.canvas_edges` | `links` |
| regions in properties | `regions` |

Fork it into `linux/`. Do not extract a shared package: Hermes runs on a server
and Talaria runs on this machine, they are separately deployed, and a build-time
coupling between them is a coupling the owner has asked not to have.

**The one part that needs real work:** Hermes renders a placed block as a
`BlockCard` — a live editor against the Hermes API. Talaria's block nodes are a
title, a type icon and a completion box, read from the local mirror. That node
type has to render differently. A fork is the right place to pay that.

## The contract that must not break

**`canvas.json` is the interface, and Canvas Chat is its other user.**
`../packages/daemon/src/canvasagent.ts` builds and edits canvases through
`canvas.ts`. Whatever renders must read and write that same document, in that
same shape. Change the file format and the chat stops being able to build a
canvas — which is a feature the owner asked for specifically.

**What the renderer does not understand, it must not destroy.** A canvas holds
keys this UI may not know. Hold the document as it arrived and touch only
`items`, `links` and `regions`. The daemon's `PUT /canvas/document` is
`passthrough` for the same reason; zod strips unknown keys by default and would
have quietly undone it.

**Reach Hermes only through pkm-interchange.** A standing instruction from the
owner, and the reason `packages/canonical` exists. When the format cannot say
something, say so and ask — do not reach around it.

## Making the daemon run here — done, and what it cost

Run `linux/install.sh`. It needs Node 22+ and a `pnpm install` at the repo root,
checks for both before it writes anything, and ends on `talaria doctor`.

The list was accurate and each item was about one constant, with one exception
noted below:

- `daemon/src/config.ts` — `HOME` is XDG off macOS, `~/Library` on it. **Unset
  and empty are both fallbacks**: a KDE session exports `XDG_DATA_HOME` as an
  empty string, and reading it literally puts the mirror in `/talaria`.
- `packages/cli/src/clipboard.ts` — new. `pbcopy`, then `wl-copy`/`xclip`/`xsel`
  ordered by session type but all tried, because XWayland. Returns which one
  took it, so `--copy` with no tool installed still prints the link instead of
  losing it.
- `cli/src/link.ts` — `osascript` guarded. Even a perfect Linux answer would be
  a window class, and the style table it feeds is keyed by bundle id.
- `daemon/src/glance.ts` — Linux ollama paths added to the same list.
- `daemon/src/server.ts` — the hand-built path now reads `HOME`. It was the same
  directory by a different route, so `TALARIA_HOME` moved every other file and
  silently left that one behind.
- `linux/systemd/talaria.service.in` — replaces the plist, and **supervises**,
  which the plist deliberately does not. It also stops rather than respawning on
  exit 78, which the plist's own comment names as a cost it was accepting.

**The exception, and it is the one worth knowing about.** `daemon/src/context.ts`
is not one constant. It reads the frontmost window through `lsappinfo` and
workspaces through `aerospace` — both macOS, both polled every two seconds. They
are guarded behind `MACOS_WINDOW_SOURCES` and return nothing here, so `/context`
degrades instead of spawning doomed processes forever. **That means the context
record is empty on Linux**, and it is a gap rather than a fault: `talaria doctor`
says so in those words. KWin is what fills it, and that is step 4.

One duplication was found rather than introduced: `cli/src/client.ts` keeps its
own copy of the socket path, because the CLI depends only on `@talaria/canonical`
and importing the daemon's config would drag fastify in to learn one string. The
copy had already drifted — the first Linux run brought the daemon up and then
reported it down. **Change one, change the other.**

Note the daemon is bundled by esbuild into a single file. **esbuild copies no
static assets**; whatever build ships the web UI has to carry the directory
across itself.

## The shell

`shell/talaria-shell` — PySide6, because Plasma 6 is Qt 6 and the alternative
was a second toolkit's idea of a tray icon. Needs
`python3-pyside6.{qtwidgets,qtgui,qtwebenginewidgets,qtnetwork}`.

| | |
|---|---|
| `shell.py` | tray, menu, panels, the toggle. The Mac's `main.swift` around its `NSStatusItem`, minus nine hundred lines, because the panels are pages rather than AppKit. |
| `scheme.py` | `talaria-app://daemon/…` into the socket. `/ui/` is served from disk, everything else is the daemon's. |
| `settings.py` | every field the Mac panel edits, plus model discovery. |
| `probe.py` | `/api/tags`, filtered by capability. A port of `Probe`. |
| `shortcuts.py` | hotkeys, through the portal. |
| `krunner.py` | the library in KDE's search box — the entrance you reach by typing on the desktop. `org.kde.krunner1` on a GLib thread, answered out of the daemon; `dev.talaria.runner.desktop` is how Plasma finds it, and `install.sh` puts it in place on a Plasma session. |
| `ui/` | the pages. `board.html` renders all six collection kinds; `desk.html` is the full-screen surface, with the canvas and a writing surface either side of it. |
| `ui/writing.html` · `ui/richtext.js` | the writing surface — a blank page with a real toolbar, saving itself into `~/.local/share/talaria/writing` as Markdown. **No connection to Hermes Notes**: no blocks, no types, no interchange, no daemon. `/shell/writing` is answered by `scheme.py` out of a directory, so it works with the daemon stopped. |
| `ui/notefield.js` · `ui/mentions.js` | the long-text editor — every block rendered except the one the caret is in, with `@`/`#`/`|` pickers. Used by the desk's Today pane *and*, imported at runtime, by canvas notes. |
| `ui/compose.html` | New Block. Summoned with something selected, it arrives filled in — the first line as the title, the whole selection as the body, laid into whichever fields the *type* declares. `toggle` reads before it shows the panel, the order Glance keeps and for the same reason. |
| `export.py` | a canvas to a PNG or a PDF. Opens the page off-screen with `?export=1` and photographs it, because a page cannot render itself to a PDF or ask where to put a file. |
| `frontmost.py` · `blindlist.py` · `glance.py` | who is in front, what must not be read, and the ladder. |
| `../canvas/` | the canvas fork. Built with vite into `shell/ui/canvas/`. |

**Never start the shell from inside another application** — not from an agent's
shell, not from a terminal that is itself a child of something else. The portal
identifies a non-sandboxed app by its process, so KDE files the hotkeys under
whatever launched it: they appear in `kglobalshortcutsrc` under that
application's component, bound to nothing, while the real bindings sit in
`[token_talaria]` unreachable. It looks exactly like "hotkeys stopped working"
and it has been diagnosed three times. Start it the way the desktop starts
things:

```bash
systemd-run --user --scope --unit=app-dev.talaria.shell -- <repo>/talaria/linux/shell/talaria-shell
```

**Do not use `kglobalaccel`.** It is undocumented, unversioned, and on Plasma 6
Wayland it is hosted *inside `kwin_wayland`* — so a malformed argument is not an
error, it is a dead compositor. One `setShortcutKeys` call carrying `a(ai)` took
the session down during development. `org.freedesktop.portal.GlobalShortcuts` is
specified, versioned, and lives in a separate process that respawns. The cost is
that bindings live in the portal's store rather than System Settings;
`talaria-shell --rebind` reopens its dialog.

### Things that cost an hour here, so they do not cost another

- **A sticky's cut corner was on every note, whatever shape it was.**
  `.cv-note .cv-paper` carried the post-it clip from before a note could be any
  shape but a sticky. When shapes arrived only three of them re-declared
  `clip-path` — ellipse, triangle, post-it — so a note asked to be a rectangle,
  or left rounded, kept the cut lower-right corner and nothing anywhere took it
  off. The rule beside it already stated the intent ("only a post-it has a
  folded corner") on the assumption that "the clip a shape sets already
  overrides the note's", which is true of the three that set one and false of
  the two that do not.
- **The tool strip and the renderer had different shape vocabularies.** The
  strip offered `roundedRectangle` and `plain`; `CanvasView` knows an absent
  shape (rounded), `rectangle`, `ellipse`, `triangle` and `postIt`. A node
  dropped as a `roundedRectangle` matched no rule and fell through to the sticky
  styling underneath, which is how choosing Rounded produced a post-it. The
  rounded default is an *absent key*, not a name — `document.ts` reads it that
  way and writing a name for it would put a shape in the file nothing there has
  ever meant.
- **An export is framed three times, and each one was wrong differently.** The
  window is sized to the drawing, so the page has to be measured *before* the
  window exists — and then re-fitted after, which the page's own `resize`
  handler did not do in time on Wayland: correctly sized, framed for the old
  window, right-hand side outside the picture. The shell calls `__exportFit()`
  and waits for the answer now; asking is deterministic, an event is a hope.
  Then the bounds were taken from the nodes alone, and a connection is a curve
  through a control point pulled off the line between its ends — it bows well
  outside both, and got clipped while every node sat comfortably inside. And
  including `.cv-svg path` to fix that swept up the **arrowheads in `<defs>`**,
  whose bbox is a 10×10 box at the origin in the marker's own coordinates: the
  drawing's bounds sprang back to 0,0 and the export came out half again as wide
  with everything crowded into a corner. `getBBox` is exact and free, and the
  filter is `closest("defs")`.
- **`printToPdf` with no page layout prints A4.** It re-lays the web page out
  for the paper rather than photographing it, so anything past the page width is
  simply gone. The layout is the window's own size now, in points at the 96dpi
  the engine lays out in — the PDF is the picture rather than a print of it.
- **The shell is `__main__`, so `import shell` builds a second copy of it.**
  The fix below reached for the profile with `import shell` from `export.py` —
  and `talaria-shell` runs `python3 shell.py`, so that module is `__main__` and
  is not in `sys.modules` under its own name. The import re-executed the file as
  a *second* module with its own `PROFILE = None`, which built a second
  `QWebEngineProfile` on the same storage directory: the page still failed to
  load, and the application froze. The profile lives in `webprofile.py` now,
  which neither of them owns and both import by name.
- **A second `QWebEngineView` gets the *default* profile, which knows no
  schemes.** The PNG and PDF export opened its own off-screen view with a bare
  `QWebEngineView()`, so it asked `defaultProfile()` for a `talaria-app://` URL
  and the load failed before anything was drawn — `talaria: export png — page
  FAILED to load`, every time, for as long as the feature has existed. The
  handler is installed on the shell's *named* profile and every view that needs
  it has to be built on that one. `shell.profile()` is public now for exactly
  that reason.
- **`vite build` does not typecheck, and two live handlers were undefined.** The
  canvas's "Save…" pointed at a bare `save` that is not a function, not an
  import and not a global, so clicking it threw — and the shipped bundle carried
  `onClick:save` with nothing behind it. `addNote`, which double-clicking blank
  canvas calls, was the same. `install.sh` runs `tsc --noEmit` before the build
  now and fails on it: a canvas that compiles to a `ReferenceError` is not a
  canvas that built.

  Turning the check on found more than the two. The `@hermes/shared` shim had
  **invented** `FilterGroup` as `{op, rules, groups}` where Hermes and every use
  of it say `{kind, match, items}`; `BlockSearchResult` was imported from a
  module that never exported it; and `NodeCtx.image` — read on every render to
  decide whether a node draws as its photograph — was never declared, which is
  why nobody noticed `ctxOf` was not carrying it. A placed block shown as its
  picture came back as a card after a reload, along with its alignment and its
  ink. A shim that renders nothing still has to describe the thing it stands in
  for, or it lies about its caller.
- **The primary selection is global, so it is the wrong answer to an ambient
  question.** Once rung 3 worked again it started answering every ambient read,
  and it does not change when the focus does — so Glance followed the window and
  said the same thing about each one. A summon may have it ("read what I have
  selected"); a tick nobody asked for may not, and falls to a rung that is about
  *this* window. That is what `asked` is for in `glance.read`.

- **`runJavaScript` cannot return an object.** Measured, after rung 2 spent this
  long looking like an empty desk: `"hello"` comes back `'hello'`, `2 + 2` comes
  back `4.0`, `document.title` comes back fine — and `({a: 1})` and `[1, 2, 3]`
  both come back as **`''`**. So `harvest.js`, which returns `{text, how}`,
  never once reached Python; `_summon_glance` saw nothing worth using and fell
  through to reading whatever window was behind the desk, which is precisely the
  defect rung 2 exists to fix. `JSON.stringify` on the page, `json.loads` on this
  side. `export.py` already carried that workaround without saying why — this is
  the why.
- **`return` and a block comment is automatic semicolon insertion.** The fix
  above was first wrapped as `return <harvest.js> ?? null`, and `harvest.js`
  opens with a block comment — so a line terminator sat between the keyword and
  the expression, ASI ended the statement there, the function returned
  `undefined`, and the harvest that followed ran as dead code and was thrown
  away. It looked exactly like a page with nothing on it, which is the same
  symptom as the bug it was fixing. Assign first, return the name.

- **The desk was a panel, and panels dismiss themselves.** Summoning Glance over
  the desk made the desk vanish: `_build` constructs it with `floating=True`
  like everything else — frameless, translucent, drawing its own frosted sheet —
  and inherited the rule that a summoned thing goes away when you look
  elsewhere. A KWin probe found exactly one Talaria window in the stack at any
  moment, which is not what "the desk is a surface you put things on" means.
  Dismissal is its own flag now (`Panel.dismisses`), because it is not the same
  question as whether something *looks* like a panel — `view_is_panel` still
  governs the frosting and the appearance.
- **Losing focus only means something if it was ever held.** With the desk
  staying put, the panel summoned onto it hid instead: a Wayland client is
  usually not granted focus when it asks, so the desk remained active and the
  panel read that as being dismissed. The first answer — "hide only if nothing
  of ours is active" — kept the panel up and cost the gesture it exists for,
  because clicking off Glance onto the desk then dismissed nothing. The question
  those two were confusing is whether this window ever *had* the focus it just
  lost: `Panel._had_focus`, set on `WindowActivate` and cleared by every summon.
  A deactivation without it is the summon itself; with it, somebody looked
  away.
- **`WindowStaysOnTopHint` does nothing on Wayland.** It is set on every panel
  and the probe read `keepAbove=false` on all of them — there is no protocol for
  a client to raise itself out of its layer, the same reason placement and
  sizing already live in `kwin/talaria-window.js`. So the flag is honoured
  there, where it is a property KWin owns: panels get `keepAbove`, and the desk
  is named and excluded, because a desk that kept itself above the things
  summoned onto it would be the arrangement upside down.

- **A runner without `X-KDE-PluginInfo-EnabledByDefault=true` is installed and
  switched off.** KRunner reads the plugin file, lists it in its settings, and
  never calls it — indistinguishable from a runner whose D-Bus service is
  broken. Every runner Plasma ships carries the line. `dbus-monitor --session
  "interface='org.kde.krunner1'"` is how to tell the two apart: if `Actions`
  and `Match` never arrive, the problem is the plugin file, not the code.

- **`job.requestBody()` on a GET is a segfault.** PySide tries to wrap the null
  `QIODevice*` and dies inside `getWrapperForQObject` — on the first request the
  page makes, after the window has already rendered. Ask for a body only when
  the method can carry one.
- **`fetch` does not work over a custom scheme here, and `XMLHttpRequest` does.**
  Qt gates the Fetch API on `FetchApiAllowed`, and in this PySide6 build
  `registerScheme` does not stick at all — `schemeByName` reads back empty for
  every name. Navigation and subresources still work, so the pages render
  perfectly and every request fails as "Failed to fetch", which looks exactly
  like a dead daemon. See the note in `ui/api.js`.
- **`overflow: hidden` is still a scroll container.** The desk moves its rail by
  transform and clips it — with `hidden`, which has no bars and scrolls
  perfectly well when the browser decides to reveal a focused element. A field
  autofocusing inside a quadrant left the desk at `scrollLeft: 1599` while the
  rail still said `translateX(0)`, so the surface on screen was not the one the
  rail thought it was showing and the canvas sat 1577 pixels off to the left.
  Everything downstream looked like an input-routing bug: swipes over "the
  canvas" were swipes over the rail, and the canvas never saw a wheel event at
  all. `overflow: clip` creates no scroll container. Measure `scrollLeft` before
  believing a hit-test.
- **A header cannot carry an em dash.** The request body rides in
  `x-talaria-body` because `requestBody()` segfaults, and `setRequestHeader`
  refuses anything outside Latin-1 — "String contains non ISO-8859-1 code
  point". So every write containing a curly quote, an em dash or an emoji threw
  *before it left the page*: the panel showed the text it had just failed to
  save and said nothing. Both codebases escape above 127 to `\uXXXX` now, which
  is still valid JSON, so nothing on the daemon's side changes.
- **Nothing may be parented to a `QWebEngineUrlRequestJob` that outlives it.**
  The reply object was, so a worker thread emitted on freed memory — the same
  crash `DaemonScheme.swift` documents, in a different language.
- **A streamed reply ends inside `readData`, and nowhere else.** The assistant
  is the one surface that streams, so `scheme.py` answers it with a sequential
  `QIODevice` it is still writing to. Two things about that device cost an hour
  each. Chromium calls `readData` **off the main thread**, so deferring the
  close with `QTimer.singleShot(0, …)` posts it to a thread with no event loop
  and it never fires — the page renders the whole answer and sits with its send
  button disabled forever, because the request never completed. And on the
  socket side, `HTTPResponse.read(n)` waits for all `n` bytes: a small reply
  arrived in one piece at the very end, 32 seconds to first byte on a turn that
  took 32.6. `read1` returns what has landed.
- **A tray app must refuse to be a second copy.** Autostart plus one manual
  launch is two icons, and the second is indistinguishable from the first.

## Glance, which is the hard part

Reading the selection out of whatever application is in front. On macOS it is a
ladder of seven, each catching what the one above missed. Read
`../app/Sources/GlanceView.swift` — the reasoning is written down there.

1. **A blindlist, applied before any read.** Password managers, by bundle id;
   here, by window class and `/proc/<pid>/exe`. Mirrored in
   `daemon/src/context.ts` as `TITLE_BLIND`, with a build check that fails if the
   two drift. The promise is "we did not look", not "we discarded it". Keep that
   promise first, before anything else works.
2. Selection in our own windows — the same JS bridge.
3. **The primary selection** (`xclip -o -selection primary`, `wl-paste
   --primary`). *This rung does not exist on macOS and is free here.* No
   synthesis, no permissions, no accessibility tree. Try it early; it is often
   the whole answer.
4. AT-SPI2 over D-Bus for selected text. Good for GTK and Qt. Electron needs
   `--force-renderer-accessibility`; terminals expose nothing, which is a real
   regression from macOS.
5. **A browser extension** reporting the selection over native messaging. Better
   than the macOS path, which needs a developer setting ticked and cannot script
   Firefox at all.
6. Synthetic copy, with the clipboard saved and restored. On KDE use the
   RemoteDesktop portal or `org_kde_kwin_fake_input`; on X11, `xdotool`. **Not
   `ydotool`** — it wants `/dev/uinput` and root, which is the wrong trade for
   filling in a form. Note Wayland has no `changeCount`, so "nothing was
   selected" and "hasn't landed yet" are harder to separate than on macOS.
7. Window title, blindlisted the same way.

### The ladder does not run on the thread that draws

Every rung below our own windows blocks: `wl-paste` is a process to spawn and
wait for, the accessibility walk is synchronous D-Bus, and the synthetic copy
presses a key and waits to see what lands. On the GUI thread — which is where a
hotkey arrives — that freezes the application for as long as they take, and KWin
marks the window *(Not Responding)* while the panel that was summoned sits
unpainted. It only became visible when panels stopped dismissing themselves and
stayed on screen long enough to be seen doing it.

`Reader` runs the read on a worker and hands the answer back on a queued signal,
which is how it re-enters the GUI thread: the reading is a value and the panel is
a window, and only one of those may be touched from there. Two things this needs
that are easy to miss. The reader is **held on `self`** for the length of the
read — a `QObject` whose only reference is a local is collected when the method
returns, and a collected reader emits nothing. And `primary_selection` takes
`allow_qt`, false off the main thread: on X11 it would otherwise reach for
`QClipboard`, which belongs to the GUI thread. `xclip` is the answer there, and a
subprocess is safe anywhere — which is the whole reason the read moved.

### The primary selection is offered only to the focused client

Two bugs, one platform fact, and between them they had quietly disabled rung 3
for every application that is not a browser — Glance answered with the window
title and looked like it was working. Both were found by way of New Block
arriving empty, which is the same rung read through a different panel.

Measured before either was believed: a Qt client with no focused window received
**zero** `selectionChanged` events while another application set the primary
selection twice.

- **`primary_selection()` asked Qt first**, which was put there for a good
  reason — every `wl-paste` is a new Wayland client, KWin reports one as an
  activated window, and sampling on each focus change fed itself and flashed the
  screen. But on Wayland our clipboard holds nothing unless one of our windows
  has focus, so it returned `""` and the function reported *"nothing is
  selected"*: an answer about the desktop, confidently wrong. Qt is now used on
  X11, where it is correct and free, and `wl-paste` on Wayland. It takes focus
  for an instant to ask — the same cost that made the old sampling loop flash,
  and it is fine here because this runs once, when somebody presses a key.
- **`SelectionClock` cannot see anybody else's selection**, so its ticks are
  only ever about Talaria's own windows. `selection_is_stale` then read a tick
  older than the current focus as "made somewhere else", which is true of every
  external selection the moment any panel has been used. The failure had a
  signature worth recognizing: it worked after a restart and stopped for good
  once you selected anything inside a Talaria window. The clock now says whether
  it can see anything but itself — from the platform name, not from a runtime
  probe, because the first probe was fooled within the hour by a tray
  application with no window reporting `ApplicationInactive`.

### What the rungs actually returned here

Measured, not assumed. Keep this up to date rather than re-deriving it.

| | |
|---|---|
| **Rung 3, primary selection** | Answers most often, and is the only rung for terminals and anything AT-SPI cannot see. **It is global and persistent** — it holds the last thing highlighted by *any* window and cannot say which, so it returned a terminal transcript to somebody working in Kate. Never trust it when rung 4 could see the focused window and reported nothing selected. |
| **Rung 4, AT-SPI** | Useless until `gsettings set org.gnome.desktop.interface toolkit-accessibility true` — four applications visible before, eighteen after. Scoped to the focused window, which is the property rung 3 lacks, so it is asked *first*. |
| **Firefox** | Invisible to AT-SPI until restarted with `toolkit-accessibility` on — the same lazy-tree behavior `GlanceView.swift` documents for macOS, where browsers build the web-content tree only when they believe an assistive technology is listening (`AXManualAccessibility` there, `org.a11y.Status` here). After a restart it exposes ~1000 nodes of structure and **still never reports a text selection** — not on a Google Doc and not on an ordinary news page where the selection was plainly there. Rung 3 reads that page without difficulty. So Firefox is covered, by rung 3, and rung 4 has no opinion about it. |
| **Google Docs** | Covered by neither. The document is drawn to a canvas, so it is not in the accessibility tree, and highlighting in it sets no primary selection. **Rung 5 is the only thing that would read it** — and on the evidence that is what rung 5 buys: this application, not "the browser". |

**Measure with the window focused.** Every early conclusion here was wrong
because the probe was run from a terminal, so the terminal was in front. A
browser that is minimized or merely unfocused does not maintain its web-content
tree, and rung 4 looks for the *active* frame — so "AT-SPI returns nothing,
ever" was measured against a window the ladder would never have read.
`glance_watch.py` samples on a timer for this reason, and prints every sample
rather than only the changes: a rung that keeps returning nothing while text is
plainly selected is itself the result, and deduplicating hid exactly that.

**Prototype rungs 3 and 4 against the applications actually used before building
any of this rung by rung.** A day's script that reports what each rung returns
per app. If
the primary selection plus a browser extension covers the real workflow, rung 6
never needs building — and it is the most fragile part and the only one with a
side effect.

## What is in this directory

- `install.sh` — writes the user unit and proves the daemon came up by asking
  the socket. Everything that can fail is checked before anything is installed,
  which is the `build.sh` lesson below restated.
- `systemd/talaria.service.in` — a template, not a unit. `ExecStart` must be an
  absolute path and there is no machine-independent absolute path to node, so
  the installer substitutes one rather than hardcoding somebody's.
- `reference/DaemonScheme.swift` — a `WKURLSchemeHandler` proxying a custom URL
  scheme into the daemon's Unix socket, so a web view can talk to it with no TCP
  port open. WebKitGTK has the same mechanism; this is the design worked out
  once. It carries hard-won detail: headers to stderr and body to stdout so
  binary survives, and the pipe read *before* the process is waited on, because
  a reply larger than the pipe buffer deadlocks otherwise.
- `reference/CanvasWebWindow.swift` — the window that held it.
- `canvasapp/` — a web canvas written in one session and **superseded**. Do not
  build on it. It is here for two things worth keeping: `shapes.js` and
  `snap.js` are faithful ports of `CanvasShape.path(in:)` and `CanvasSnap`,
  tested, and the link geometry in `canvas.js` is a correct port of
  `LinkGeometry` — anchors are side-centres, the control point is midpoint plus
  *twice* the bend, and the grip sits at midpoint plus the bend.

## The writing surface

The third surface, and the only one with nothing of the library in it. What it
keeps of Talaria is the desk it sits on: every hotkey still works over it
(those are the compositor's), the swipe between surfaces is handed up by
`api.js`, the frosting switch reaches it the way it reaches the canvas, and
Glance can read it, because the page marks its content with `data-context` like
every other page here.

**The page is the whole width, and the typeface is the writer's.** The first
version used a 46rem measure, on the usual argument that long lines are harder to
read — which is an argument about reading prose you did not write. A full-screen
surface somebody opened on purpose is a desk, and a column down the middle of it
with two empty thirds either side reads as a page that failed to load. The
toolbar carries a face and a size instead: four faces this project already has an
opinion about (the system stack, a serif, Verdana because that is Hermes' body
face, and a monospace) and a size list. Both live in the browser's own storage
per surface rather than in the file, because what a document *says* and what it
looks like while somebody writes it are different questions, and only the first
belongs in something other programs will read.

**Arithmetic is Calca's notation, because it is the only one that is also a
file.** Soulver, Numi and Tydlig are line calculators with their own document
formats; Calca's documents are Markdown, `rent = 1850` names a value, and a line
carrying `=>` is answered after the arrow. So that is what `calc.js` implements,
and the answers are written *into* the line — somebody opening the file in
anything else sees the arithmetic and its results. A fenced ```calc block is the
same thing for a column of workings, where every line is a question and the
arrow can be left off. One scope, in reading order.

Two things it must not do, both of which it did first: escape the expression
(`say()` turns `rent * 12` into `rent \* 12`, so a calculation line is written
verbatim and is marked in the DOM for that reason), and answer prose. `=>` is
not rare in a note — implication, quoted code, an arrow somebody drew — and
"A sentence with an arrow => that is not arithmetic" came back answered
*nothing called “A” yet*. A question now has to carry an operator, or be a single
term, before it is treated as one; a typo in a real sum falls through that and
simply gets no answer, which is the quieter way to be wrong.

**Markdown, not HTML.** HTML would have made `richtext.js` twenty lines long and
the directory worthless — a writing app whose work can only be read by itself is
a trap. The cost is a serializer that has to be exact, because it runs on a timer
while somebody is typing and its output replaces the file they are typing into.
Every construct round-trips byte-identically and is stable on a second pass;
that was tested in a browser rather than reasoned about.

Four things the browser said that the design had not:

- **A first line typed into an empty page is a bare text node**, not a
  paragraph, until Enter wraps it — and a walk over `children` skips it
  entirely. One line, never saved. An empty `<p>` is also not something a caret
  can go in, so it now carries a `<br>` the way browsers write one themselves.
- **`execCommand("indent")` nests a list as a *sibling* of the item**, not
  inside it, and strips the checklist marker on the way. Both shapes are read
  back, and `tidy()` restores the marker rather than intercepting the command.
- **`execCommand` leaves styled spans behind** — `outdent` wrapped an item's
  text in the sheet's own translucent background, copied out of the computed
  style. Nothing here makes a styled span, so any that appears is unwrapped.
- **An indented block and a quote are the same thing, so they look the same.**
  Indent was list-only at first, on the argument that Markdown has no indented
  paragraph. It has exactly one: `>` nests, and nesting it is what shifting a
  block right *means* in this format. So `execCommand("indent")` outside a list
  is allowed to do what it already does — wrap in a blockquote — and the
  stylesheet draws that as indentation with a light rule rather than as a pull
  quote. The two are indistinguishable in the file because in Markdown they are
  the same construct; pretending otherwise would mean an indent that came back
  as a quotation on the next open.
- **The browser styles what it builds.** `execCommand("indent")` writes
  `margin: 0 0 0 40px; border: none` onto its blockquote, which overrides the
  stylesheet — so an indent looked one way while you made it and another way
  after the file was reopened, since the copy that comes back from Markdown
  carries no styles. Nothing here ever sets an inline style, so `tidy()` strips
  every one of them.

## Things that cost a day, so they do not cost another

- **The web canvas crashed the Mac app.** `EXC_BAD_ACCESS` in `objc_release`
  during autorelease-pool drain, minutes after launch, naming nothing. Closing
  the window while requests were in flight is the suspect and holding the tasks
  strongly did not fix it. The cause was never found — it was removed instead.
  If a WebKit shell here starts crashing the same way, that is the history.
- **A dying daemon deleted its successor's socket.** Two overlap on every
  restart; the old one's close hook unlinked a path the new one had just bound,
  leaving a process alive and listening on an inode with no name. Fixed with an
  inode check. Watch for it in any restart script written here.
- **A build that reports success and does nothing.** `build.sh` wrote the daemon
  bundle *before* compiling, so a compile failure left every visible sign of a
  good build and an untouched binary. Put the thing that can fail first, or
  check what you produced.
- **Ask the socket, not the process list.** `ps` showing a daemon proves
  nothing; a `curl --unix-socket` against `/health` is the only answer that
  means anything.
- **Test a UI in a browser, not a stub.** A DOM stub answered every arithmetic
  question correctly while the real page rendered at a fifth of life size, with
  invisible borders and drags multiplied by five. All three were one bug, and
  none of them were visible to the stub.

## Still open

Named rather than implied, in the order they cost something.

- **An attachment cannot be carried through the format.** Its `attachment` value
  is a file name and there is no channel for the bytes; Hermes' manifest declares
  attachments unsupported besides. So a picture converted into a block stays on
  the canvas, beside `canvas.json`, and is visible on that canvas and nowhere
  else in the library. Written up as the open entry in
  `../../pkm-interchange/LIMITS.md`, with the two shapes an answer could take.
- **Glance rung 5 — the browser extension.** Everything else on the ladder is
  built. What this buys is one application rather than "the browser": Google Docs
  draws its document to a canvas, so the accessibility tree cannot see it and
  highlighting sets no primary selection. Everything else a browser shows is
  already covered by rung 3.
- **`AMBIENT.md` is partly built now.** #1 the reference picker (Meta+Shift+L),
  #2 the context record (the KWin script fills it) and #3 the ambient panel
  (Glance follows the focus signal while it is open) are done. #4, workspace
  binding, is skipped — nobody here works in workspaces. #5, background
  inference, is done: `packages/daemon/src/propose.ts`, a queue at
  `GET /proposals`, and Meta+Shift+I to read it — waiting and dismissed on two
  tabs, because a dismissal is kept rather than deleted and "no" is a decision
  worth being able to take back.

  Its Alfred line — "one more search entrance; already fed by `talaria alfred`;
  nothing new required" — has a counterpart here in `shell/krunner.py`. Two
  things had to be decided that Alfred never asks. **An unprefixed query sees
  only titles**: the daemon searches full text, which is right where somebody
  has already said which haystack they mean, and wrong in a box full of
  applications and files where a title with no visible relation to what was
  typed reads as a broken runner. `hn` is how you ask for the rest. And **forty
  are fetched to keep ten**, because ranking by full text buries the block
  *named* the word below any short limit — `q=learning` did not return the note
  called "Learning" in the first ten.

  Worth knowing where this platform beat the design: AMBIENT asks for a panel
  "redrawn on the context signal rather than on a timer", and the Mac cannot do
  it — `GlanceView.startFollowing` polls every four seconds because "nothing on
  this machine emits a 'the focused document changed' event". KWin emits one.
- **Canvas leftovers, all cosmetic.** No gesture adds a *second* picture to a
  node that already has one (the chooser and the sweep both handle several; only
  loading and converting ever make them). The PNG export is a bitmap of the
  fitted canvas rather than vector art, because the drawing lives in a browser
  and the Mac's route — walking the items and drawing them again — is not open to
  it.

## House style

The repo's conventions apply here. Comments explain *why*, decisions carry their
reasoning, and American spellings throughout — including in commit messages.
Commit and push to `main` without asking; that is a standing instruction.
