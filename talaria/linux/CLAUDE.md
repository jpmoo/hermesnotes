# Talaria on Linux

Orientation for a coding agent picking this up on a KDE desktop. **Steps 1, 3
and most of 4 are done; step 2 (the canvas fork) and step 5 (Glance) are not.**
The daemon runs under systemd, a tray shell holds four panels, and hotkeys come
through the shortcuts portal. The canvas is still read-only.

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
2. **Fork Hermes' canvas.** This is the first real piece of UI and the decision
   is already made — see below. It is also the safest: the component is mature,
   the adapter is the only new code, and Canvas Chat keeps working throughout
   because `canvas.json` never changes.
3. ~~**A shell to hold it.**~~ **Done** — `shell/`, PySide6 on Qt 6. Tray item,
   four panels, settings window, and the scheme handler the canvas will reuse
   unchanged.
4. **Compositor integration.** Hotkeys: **done**, through the portal — see the
   warning below about the route not taken. Focused window and title from KWin:
   **not done**, and it is what `context.ts` is waiting on.
5. **Glance last, and prototype before building.** It is the hard part and the
   only piece that might not reach parity. Everything above is worth having
   whether or not it does.

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
| `ui/` | the pages. `board.html` renders all six collection kinds. |

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
- **Nothing may be parented to a `QWebEngineUrlRequestJob` that outlives it.**
  The reply object was, so a worker thread emitted on freed memory — the same
  crash `DaemonScheme.swift` documents, in a different language.
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

## House style

The repo's conventions apply here. Comments explain *why*, decisions carry their
reasoning, and American spellings throughout — including in commit messages.
Commit and push to `main` without asking; that is a standing instruction.
