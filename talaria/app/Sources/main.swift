import AppKit
import CoreSpotlight
import Foundation
import SwiftUI
import UserNotifications

/// Talaria.app — a daemon wearing a bundle.
///
/// It has no windows and never will (brief §2). The bundle exists because three
/// separate pieces of macOS insist on one: CoreSpotlight refuses to index for an
/// executable whose bundle id it cannot resolve, LaunchServices needs a bundle
/// to route a URL scheme to, and System Settings names a background item after
/// the app responsible for it.
///
/// What it does:
///   - runs the node daemon as a child, and restarts it if it dies
///   - keeps Spotlight in step with the mirror
///   - opens `talaria://` links, and Spotlight results, in the web app
///
/// Everything that involves knowing what a block *is* happens in the daemon.
/// This is the part that is slow and awkward to change, so it stays thin.

// MARK: - Supervision

/// The node daemon, kept alive underneath us.
///
/// One login item rather than two: the pair is one thing from the user's point
/// of view, and a supervision tree beats two agents that can disagree about
/// whether they are running.
final class DaemonProcess {
    private var process: Process?
    private var stopping = false
    private let root: URL

    init(root: URL) { self.root = root }

    func start() {
        guard !stopping else { return }
        let node = URL(fileURLWithPath: "/opt/homebrew/bin/node")
        // Bundled next to the app in Application Support, never run from the
        // repo: ~/Documents is TCC-protected and a LaunchAgent cannot read it.
        let entry = root.appendingPathComponent("daemon.mjs")
        guard FileManager.default.fileExists(atPath: node.path) else {
            NSLog("talaria: no node at \(node.path)")
            return
        }
        guard FileManager.default.isReadableFile(atPath: entry.path) else {
            NSLog("talaria: can't read the daemon at \(entry.path) — run talaria/install.sh")
            return
        }
        let p = Process()
        p.executableURL = node
        p.arguments = [entry.path]
        p.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["TALARIA_SUPERVISED"] = "1"
        p.environment = env
        p.terminationHandler = { [weak self] proc in
            guard let self, !self.stopping else { return }
            NSLog("talaria: daemon exited (\(proc.terminationStatus)); restarting in 5s")
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { self.start() }
        }
        do {
            try p.run()
            process = p
            NSLog("talaria: daemon started (pid \(p.processIdentifier))")
        } catch {
            NSLog("talaria: could not start daemon: \(error)")
        }
    }

    func stop() {
        stopping = true
        process?.terminate()
    }

    /**
     Pick up a changed config, now rather than in five seconds.

     Everything the daemon builds from config.json — the binding's base address,
     the sync, the embedder Glance compares against — is constructed once at
     startup, so a settings change is applied by starting again. That is the
     honest way to do it: the alternative is mutating half a dozen live objects
     and discovering, months later, the one that was still holding the old
     value.

     The old process's `terminationHandler` is cleared *before* it is signaled,
     because otherwise both it and this would relaunch: the handler schedules a
     start in five seconds, this one starts immediately, and the machine ends up
     with two daemons on the same SQLite file. Clearing it first makes this
     restart the only one that happens, without a flag two threads race over.
     */
    func restart() {
        guard !stopping else { return }
        let old = process
        old?.terminationHandler = nil
        process = nil
        DispatchQueue.global().async { [weak self] in
            old?.terminate()
            old?.waitUntilExit()
            self?.start()
        }
    }
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var daemon: DaemonProcess?
    private var timer: Timer?
    /// The cursor the Spotlight index was last built at. Compared, never
    /// parsed — see `Daemon.Health.cursor`.
    private var lastIndexedCursor: String?
    private var signalSources: [DispatchSourceSignal] = []
    private var statusItem: NSStatusItem?
    private var boardWindow: NSPanel?
    private var assistantWindow: NSPanel?
    private var hotkey: Hotkey?
    private var assistantHotkey: Hotkey?
    private var glanceHotkey: Hotkey?
    private var glanceWindow: NSPanel?
    private var deskWindow: NSPanel?
    /// What the menu bar and the Dock are covering, so the content can clear
    /// them while the frost still reaches the edges of the screen.
    private let deskInsets = DeskInsets()
    /**
     What is on the canvas.

     Held here for the same reason the chrome is: the desk's surfaces are built
     once and hidden rather than destroyed, so a model owned by the view would
     be rebuilt on every ⌥⇧T and the canvas would come back empty.

     It knows nothing about Hermes and is not connected to it. The canvas is
     being built as though it were a different application — which is what makes
     fitting it onto the format afterwards an honest test of the format rather
     than a formality.
     */
    let canvasModel = CanvasModel()

    /// Which surface the desk is showing, and how it is drawn. Outside the view
    /// so the swipe monitor can push into it, and so the grid and transparency
    /// settings survive the panel being hidden.
    private let deskChrome = DeskChrome()
    private var deskScroll: Any?
    /// A swipe arrives as a stream of small deltas; a page turn is the whole
    /// gesture. Accumulated here and cleared when it lands or when it stops.
    private var deskSwipeAccumulated: CGFloat = 0
    private var deskSwipeReset: Timer?
    private var deskSwipe: CGFloat {
        get { deskSwipeAccumulated }
        set {
            deskSwipeAccumulated = newValue
            deskChrome.reveal()
            deskSwipeReset?.invalidate()
            if abs(deskSwipeAccumulated) > 90 {
                deskChrome.swiped(by: deskSwipeAccumulated)
                deskSwipeAccumulated = 0
                return
            }
            // A gesture that stopped short is not the beginning of the next one.
            deskSwipeReset = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { [weak self] _ in
                Task { @MainActor in self?.deskSwipeAccumulated = 0 }
            }
        }
    }
    private let scratchpadModel = ScratchpadModel()
    private let workspacesModel = WorkspacesModel()
    private var deskHotkey: Hotkey?
    private var settingsWindow: NSPanel?
    private var composeWindow: NSPanel?
    /// Who to tell about the next block this composer makes, if anybody asked.
    private var composeHandoff: ((String) -> Void)?
    /// When this launch happened, so a reopen can be told from a Dock click.
    private var launchedAt = Date.distantPast
    private var composeHotkey: Hotkey?
    /// Watches for a click anywhere else while a summoned panel is open.
    /// Keyed by panel, because two can be up at once and closing one must not
    /// stop the other listening.
    private var dismissMonitors: [ObjectIdentifier: (Any?, Any?)] = [:]
    private let glanceModel = GlanceModel()
    private let boardModel = BoardModel()
    private let assistantModel = AssistantModel()
    private let canvasChatModel = CanvasChatModel()
    private let settingsModel = SettingsModel()
    private let composeModel = ComposeModel()

    /// Where Talaria keeps its things — and where the bundled daemon lives.
    ///
    /// Application Support, not the repo. The repo is under ~/Documents, which
    /// a LaunchAgent is not permitted to read, and nothing at runtime should
    /// depend on a directory the process may not be allowed to open.
    private var supportRoot: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/Talaria")
    }

    /**
     One of us, however we were started.

     launchd owns this app — `KeepAlive: true`, running the binary by path —
     and macOS's usual "an application is already open" check does not fire
     between a launchd start and an `open`, because those take different routes
     into LaunchServices. So a well-meant `open Talaria.app` while the agent is
     running gives you two menu bar icons with identical menus, two hotkey
     registrations racing for the same combination, and two daemons.

     Cheap to prevent and confusing to diagnose, which is the argument for
     doing it here rather than remembering not to.
     */
    private func alreadyRunning() -> Bool {
        guard let me = Bundle.main.bundleIdentifier else { return false }
        let others = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier == me && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
        }
        return !others.isEmpty
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Focused.recordTrust()
        Focused.watchFrontmost()
        if alreadyRunning() {
            NSLog("talaria: another instance is already running — this one is stepping aside")
            NSApp.terminate(nil)
            return
        }
        let d = DaemonProcess(root: supportRoot)
        daemon = d
        installSignalHandlers()
        d.start()

        // Register as the provider for the Service declared in Info.plist, and
        // tell the pasteboard server to re-read that declaration — without the
        // update the menu item can take until the next login to appear.
        NSApp.servicesProvider = self
        NSUpdateDynamicServices()

        installStatusItem()
        launchedAt = Date()
        HermesWindow.installMainMenu()

        // A panel is a way of getting somewhere. Once you have gone, it has
        // done its job and should get out of the way rather than sit in front
        // of what it just opened. Announced centrally so a new surface gets
        // this without every call site remembering to ask for it.
        NotificationCenter.default.addObserver(
            forName: Opener.didOpen, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                // Through the hide functions rather than straight to
                // `orderOut`, or the dismissal monitors outlive the window they
                // were watching and go on firing at every click for the rest of
                // the session.
                self?.hideBoard()
                self?.hideAssistant()
                self?.hideGlance()
            }
        }

        // Settings were saved. Two things have to happen and neither can be
        // done by the panel: the daemon rebuilds everything it made from the
        // config, and the hotkeys are re-registered here, where they live.
        NotificationCenter.default.addObserver(
            forName: .talariaConfigSaved, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.daemon?.restart()
                self?.installHotkeys()
                // Glance reads its own preference out of the same file, and a
                // panel that only picked it up at the next login would look
                // like the checkbox had not worked.
                self?.glanceModel.reloadSettings()
            }
        }

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { granted, err in
            if let err { NSLog("talaria: notifications unavailable — \(err)") }
            else if !granted { NSLog("talaria: notifications not permitted; captures will be silent") }
        }

        // Poll for a moved cursor rather than reindexing on a schedule: the
        // check is one cheap call and reindexing when nothing changed is pure
        // waste. First pass is delayed so the daemon has a socket to answer on.
        // Timers fire on the main run loop, which is where this object lives —
        // saying so explicitly is what lets the compiler agree.
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
            MainActor.assumeIsolated { self.syncIndexIfChanged() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            MainActor.assumeIsolated { self.syncIndexIfChanged() }
        }
    }

    /**
     A click on the Dock icon opens Hermes Notes. A restart does not.

     Those are the same message. `applicationShouldHandleReopen` is what a Dock
     click sends, and it is also what `open -a` sends at an app that happens to
     be running already — which is every rebuild, every `talaria://` link, and
     anything else that asks for the app by name. Opening a full-size web view
     on all of those is a window nobody asked for, which is why this did nothing
     at all for a while.

     Doing nothing was too blunt: clicking a Dock icon and having no window
     appear is an app that looks broken. What tells the two apart is *when*. A
     reopen that arrives in the first moments of a launch is the launch itself
     being reported; one that arrives later is a person who clicked something.
     A person cannot click before the app is on screen, so the window is short
     and nothing real is lost inside it.

     `hasVisibleWindows` is the other half. Something is already up — the desk,
     Glance, the composer — so the click means "come to the front", which macOS
     does by itself. Adding a browser window on top of a surface somebody is
     using is not what they asked for by clicking an icon.
     */
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        let age = Date().timeIntervalSince(launchedAt)
        NSLog("talaria: reopen (visible windows: \(flag), \(String(format: "%.1f", age))s after launch)")
        guard !flag, age > 3 else { return true }
        HermesWindow.shared.show()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        daemon?.stop()
    }

    /// Take the daemon down with us when we are signaled.
    ///
    /// `applicationWillTerminate` is an AppKit courtesy and a SIGTERM is not —
    /// launchd stopping this app does not run it, so the node process it
    /// started was simply abandoned. Orphans then accumulate, and because they
    /// all hold the same SQLite file open, the mirror ends up with several
    /// writers that know nothing about each other.
    func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN) // the dispatch source handles it instead
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in
                NSLog("talaria: signal \(sig) — stopping the daemon")
                self?.daemon?.stop()
                exit(0)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func syncIndexIfChanged() {
        let since = lastIndexedCursor
        Task.detached(priority: .background) { [self] in
            do {
                let health = try Daemon.health()
                // Cursor against cursor. It used to compare the sync cursor
                // against the *Spotlight* payload's epoch, which are two
                // different numbers from two different places that happened to
                // both be integers.
                guard let cursor = health.cursor, cursor != since else { return }
                let payload = try Daemon.spotlight()
                try await Indexer.reindex(payload)
                await MainActor.run { self.lastIndexedCursor = cursor }
                NSLog("talaria: indexed \(payload.count) items (cursor \(cursor))")
            } catch {
                // The daemon may simply not be up yet, which is ordinary during
                // the first seconds after login. Logged, never surfaced.
                NSLog("talaria: index skipped — \(error)")
            }
        }
    }

    // MARK: The menu bar

    /// The one visible thing this app has.
    ///
    /// An app with LSUIElement set has no Dock icon and no menu bar of its own,
    /// so without this there is no way to reach it at all — which is fine for a
    /// daemon and not fine for a board you want to look at.
    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            // The wing, as a vector.
            //
            // The old mark was line art of two speech bubbles behind a wing and
            // did not survive 18 points: undilated it drew eleven meaningful
            // pixels of a possible 324, and thickened enough to see it became a
            // blob. So this used an SF Symbol instead. A solid silhouette is a
            // different proposition — it reads at menu bar size — and a PDF
            // template is sharp on any display without shipping four sizes.
            //
            // A configured `menuBarSymbol` still wins, because somebody who
            // named a symbol meant it.
            let named = Self.configured("menuBarSymbol")
            if named == nil,
               let wing = NSImage(contentsOfFile: Bundle.main.bundlePath + "/Contents/Resources/MenuBar.pdf") {
                wing.isTemplate = true // so macOS inverts it for a dark menu bar
                wing.size = NSSize(width: 18, height: 18)
                button.image = wing
                NSLog("talaria: status item using the wing")
            } else if let sym = NSImage(systemSymbolName: named ?? "bubble.left.and.bubble.right",
                                        accessibilityDescription: "Hermes Notes") {
                sym.isTemplate = true // so macOS inverts it for a dark menu bar
                button.image = sym.withSymbolConfiguration(
                    NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
                ) ?? sym
                NSLog("talaria: status item using symbol '\(named ?? "bubble.left.and.bubble.right")'")
            } else if let icon = NSImage(contentsOfFile: Bundle.main.bundlePath + "/Contents/Resources/MenuBar.png") {
                icon.isTemplate = true
                icon.size = NSSize(width: 18, height: 18)
                button.image = icon
                NSLog("talaria: status item fell back to MenuBar.png")
            } else {
                button.title = "Hermes Notes"
                NSLog("talaria: status item has no image at all")
            }
            button.action = #selector(toggleBoard(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
        // Ask macOS whether it is actually drawing the thing, rather than
        // inferring it from the fact that we made one. isVisible is false when
        // the menu bar has no room — which on a notched Mac is common and
        // otherwise entirely silent.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            MainActor.assumeIsolated {
                NSLog("talaria: status item visible=\(item.isVisible) hasWindow=\(item.button?.window != nil) length=\(item.length)")
            }
        }

        installHotkeys()
    }

    /**
     The global shortcuts, registered from config.json.

     A hotkey as well as the menu bar, and not as a convenience: macOS silently
     drops status items that don't fit, and on a Mac with a notch and a busy
     menu bar ours is the newest and so the first to go. An entrance that can
     vanish without saying anything is not an entrance.

     All three are ⇧⌥ combinations. Option is macOS's compose modifier — ⌥B is ∫
     and ⇧⌥B is ı — which looks like a reason to avoid it and is not one, as
     long as the shortcut actually registers: `RegisterEventHotKey` consumes the
     event, so nothing is composed and nothing reaches the focused field. The
     danger is the *refusal* case. Something else already owning the combination
     means the keystroke falls through to whatever you were writing and types a
     dead-key character, which reads as the keyboard misbehaving rather than as
     a shortcut clash — so a refusal is logged saying exactly that.

     Each is cleared to nil before the new one is made, and that order is the
     whole reason this is a function rather than three assignments. `Hotkey`
     unregisters in `deinit`, and a plain reassignment constructs the
     replacement while the old one still holds the combination — Carbon refuses
     the duplicate, *then* the old is released and unregisters, and the shortcut
     is left registered by nobody. Silent, and only after a settings change,
     which is the worst time to find out.
     */
    private func installHotkeys() {
        hotkey = nil
        hotkey = register("boardHotkey", "shift+opt+c") { [weak self] in self?.toggleBoardWindow() }
        assistantHotkey = nil
        assistantHotkey = register("assistantHotkey", "shift+opt+a") { [weak self] in self?.toggleAssistantWindow() }
        glanceHotkey = nil
        glanceHotkey = register("glanceHotkey", "shift+opt+g") { [weak self] in self?.toggleGlanceWindow() }
        composeHotkey = nil
        composeHotkey = register("composeHotkey", "shift+opt+h") { [weak self] in self?.toggleComposeWindow() }
        deskHotkey = nil
        deskHotkey = register("deskHotkey", "shift+opt+t") { [weak self] in self?.toggleDeskWindow() }
    }

    /// One shortcut, from config or from the default, saying so when it can't
    /// be had. See the note above on why a refused Option combination is worse
    /// than a refused Control one.
    private func register(_ key: String, _ fallback: String, _ action: @escaping () -> Void) -> Hotkey? {
        let spec = Self.configured(key) ?? fallback
        guard let hk = Hotkey(spec: spec, action: action) else {
            NSLog("talaria: '\(spec)' was refused — something else owns it. That shortcut now does nothing, and an Option combination that is not registered types a compose character into whatever you are writing. Pick another in Settings → Shortcuts.")
            return nil
        }
        return hk
    }

    /**
     Glance: a floating widget rather than a window.

     Everything else Talaria opens is a place you go to. This appears beside
     what you are already doing, so it is chromeless, translucent, and
     `.nonactivatingPanel` — the document you were typing in keeps the cursor.
     A panel that stole focus would answer a question by interrupting the work
     that raised it, and you would have to click back before you could act on
     what it told you.

     `.canJoinAllSpaces` because it is about the front window and the front
     window can be anywhere; `.stationary` so it does not slide around during a
     space switch.
     */
    private func glancePanel() -> NSPanel {
        if let w = glanceWindow { return w }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 420),
            styleMask: [.nonactivatingPanel, .fullSizeContentView, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // A real shadow, cast from the rounded material rather than from the
        // window's rectangle. The mask lives on the effect view for exactly
        // this reason: clip the content in SwiftUI alone and the window still
        // believes it is square, so it draws a square shadow behind round
        // corners — which is most of what made it look bolted on.
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        let host = NSHostingController(rootView: GlanceView(model: glanceModel))
        host.view.frame.size = NSSize(width: 380, height: 420)
        panel.contentViewController = host
        panel.setFrameAutosaveName("talaria.glance")
        glanceWindow = panel
        return panel
    }

    /**
     The desk: the whole screen, frosted, with everything on it.

     A panel rather than a window for the same reason the others are — it must
     be able to appear over a full-screen application without shoving it aside,
     and `.canJoinAllSpaces` is what stops it being a thing that lives in one
     workspace. It covers the screen the pointer is on, not every screen: a
     second display is where somebody put the thing they are looking at.
     */
    private func deskPanel() -> NSPanel {
        if let w = deskWindow { return w }
        let panel = DeskPanel(
            contentRect: NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900),
            // Not `.nonactivatingPanel`, which the other panels use.
            //
            // That style means "do not take the keyboard", which is right for
            // Glance — a widget about whatever you are working in — and exactly
            // wrong here. The desk has a scratchpad and a composer in it. With
            // it set, Escape and every other keystroke went past the desk to
            // the application underneath, so pressing Escape to dismiss this
            // canceled whatever was behind it instead. Which is worse than not
            // dismissing: it does something, somewhere else, invisibly.
            // Titled, with the title bar made invisible — not borderless.
            //
            // A borderless panel is not a window as far as a tiling manager is
            // concerned: it never appears in `aerospace list-windows`, so this
            // app's float rule never applies to it. With `focus-follows-mouse`
            // on, AeroSpace then focused the managed window *under* the
            // pointer — whatever the desk was covering — so the desk lost the
            // keyboard the instant the mouse moved, and Escape went to the
            // application underneath. Clicking the desk first fixed it, which
            // is exactly the shape of "something else keeps taking the focus
            // back".
            //
            // A titled window is seen, matched by the float rule, left where it
            // is, and focused when the pointer is over it — which it always is,
            // because it covers the screen.
            styleMask: [.titled, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        // Escape does not dismiss this one.
        //
        // Every other panel here is a widget you summon, glance at and drop, and
        // Escape is the right way out of those. The desk is a place you work —
        // a scratchpad being typed into, a form half filled in, a canvas being
        // panned — and Escape is a key those surfaces have their own uses for.
        // ⌥⇧T is the way out, the same key that brought it up.
        panel.onCancel = nil
        // The flags a panel needs before AppKit will hand it the keyboard.
        //
        // `canBecomeKey` on the subclass says this window is willing; these say
        // the *app* is. Without `isFloatingPanel` and a level it is allowed to
        // be key at, activation went through and the window still came up
        // unfocused behind the application it was covering — so keystrokes went
        // there instead, and Escape canceled whatever was underneath.
        // A title bar exists so the window manager can see a window. Nothing
        // should be drawn for it.
        panel.title = "Talaria Desk"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // The frost. An effect view behind the content rather than a SwiftUI
        // material on it: this has to blur the *desktop*, which is behind the
        // window, and only a window-level effect view sees through to that.
        let frost = NSVisualEffectView()
        frost.material = .hudWindow
        frost.blendingMode = .behindWindow
        frost.state = .active
        let host = NSHostingView(rootView: DeskView(
            insets: deskInsets,
            chrome: deskChrome,
            scratchpad: scratchpadModel,
            workspaces: workspacesModel,
            compose: composeModel,
            glance: glanceModel,
            canvas: canvasModel,
            assistant: assistantModel,
            canvasChat: canvasChatModel,
            onCompose: { [weak self] seed, made in self?.compose(seed: seed, then: made) },
            onLeave: { [weak self] in self?.hideDesk() },
            onPickWorkspace: { [weak self] name in
                // Leave first, then go. Going somewhere is leaving here — but
                // the order matters more than it looks.
                //
                // Switching first did switch: the daemon accepted it and
                // AeroSpace moved. Then the desk closed, this app went back to
                // being an accessory, and macOS handed the foreground to
                // whatever had it before — an application living on the
                // workspace we had just left, which AeroSpace duly followed
                // back. The click worked and its effect was undone a moment
                // later by the dismissal, which is indistinguishable from the
                // click doing nothing.
                //
                // So: dismiss, let the handover settle, then ask. A tenth of a
                // second is the smallest delay that reliably lands after
                // AppKit's own activation work.
                self?.hideDesk()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    self?.workspacesModel.focus(name)
                }
            }
        ))
        // The window decides the size, not the content.
        //
        // An NSHostingView publishes its SwiftUI view's fitting size as layout
        // constraints, and pinned to the window's edges that is a demand rather
        // than a description: the composer's own minimum grew the panel to
        // 1470×1060 on a 1470×956 screen, so a quarter of the screen was
        // computed from a rectangle a hundred points taller than the screen and
        // the bottom row was drawn past the bottom of it. `sizingOptions = []`
        // is the switch that stops it asking, and springs rather than
        // constraints keep it filling whatever the window happens to be.
        if #available(macOS 13.0, *) { host.sizingOptions = [] }
        host.translatesAutoresizingMaskIntoConstraints = true
        host.frame = frost.bounds
        host.autoresizingMask = [.width, .height]
        frost.addSubview(host)
        panel.contentView = frost
        deskWindow = panel
        return panel
    }

    func toggleDeskWindow() {
        let panel = deskPanel()
        if panel.isVisible {
            hideDesk()
            return
        }
        // Read the world before covering it up, the same order every panel here
        // uses: what Glance is about is whatever this is about to sit on top of.
        NSLog("talaria: desk opening on \(deskChrome.surface.name)")
        Focused.forgetCopied()
        composeModel.load(seed: Focused.selection(allowCopy: true))
        scratchpadModel.load()
        workspacesModel.load()

        let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) })
            ?? NSScreen.main
        // The whole screen for the frost, the usable part for the content.
        //
        // `visibleFrame` alone left a strip of desktop between the menu bar and
        // the top of the panel — a seam, on the one surface whose whole idea is
        // to be a sheet over everything. The window covers the screen now and
        // the panes are inset by exactly the chrome they would otherwise hide
        // behind, so the blur runs edge to edge and nothing is underneath the
        // menu bar or the Dock.
        if let screen {
            panel.setFrame(screen.frame, display: true)
            deskInsets.top = screen.frame.maxY - screen.visibleFrame.maxY
            deskInsets.bottom = screen.visibleFrame.minY - screen.frame.minY
        }

        // Activating, unlike Glance: this is a surface to type into — a
        // scratchpad and a composer — and a panel that cannot take the keyboard
        // would be a picture of one.
        // A regular application, for as long as the desk is up.
        //
        // This app is `LSUIElement` — no Dock icon, no menu of its own — and
        // recent macOS declines activation requests from an accessory app that
        // the user did not click on. A global hotkey is not a click as far as
        // the window server is concerned, so `activate` returned having done
        // nothing: the panel became Talaria's key window while Talaria itself
        // stayed in the background, and every keystroke went to the application
        // underneath. Which is how pressing Escape over the desk canceled
        // something behind it.
        //
        // Switching policy is the documented way for an accessory app to take
        // the foreground. It is put back on the way out, so the Dock icon lasts
        // exactly as long as the window that needed it.
        NSApp.setActivationPolicy(.regular)
        // A regular application, for as long as the desk is up.
        //
        // This app is `LSUIElement` — no Dock icon, no menu of its own — and
        // recent macOS declines an activation request from an accessory app the
        // user did not click on. A global hotkey is not a click as far as the
        // window server is concerned, so `activate` returned having done
        // nothing: the panel became Talaria's key window while Talaria itself
        // stayed in the background, and every keystroke went to the application
        // underneath. Which is how pressing Escape over a full-screen overlay
        // canceled something behind it instead of dismissing it.
        //
        // Switching policy is the documented way for an accessory app to take
        // the foreground. It is put back on the way out, so the Dock icon lasts
        // exactly as long as the window that needed it.
        NSApp.setActivationPolicy(.regular)
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(panel.contentView)
        glanceModel.startFollowing()
        watchForDismissal(panel, dismissOnEscape: false) { [weak self] in self?.hideDesk() }

        /*
         A two-finger swipe across the desk.

         Read as an event rather than as a SwiftUI gesture, because the surfaces
         underneath are a web view, a form and a list, each of which has its own
         claim on a scroll — a gesture recogniser high enough to catch every
         swipe would also swallow the scrolling somebody meant for the
         scratchpad. Here the horizontal component is taken and the event is
         passed on, so a mostly-vertical scroll reaches the pane it was aimed at.
         */
        deskScroll = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self, self.deskWindow?.isVisible == true, event.window === self.deskWindow else {
                return event
            }
            let dx = event.scrollingDeltaX
            let dy = event.scrollingDeltaY
            // Decisively sideways, and from the trackpad rather than a wheel.
            guard event.hasPreciseScrollingDeltas, abs(dx) > abs(dy) * 1.6, abs(dx) > 1 else {
                return event
            }
            Task { @MainActor in self.deskSwipe += dx }
            return event
        }
    }

    private func hideDesk() {
        guard let panel = deskWindow else { return }
        stopWatchingForDismissal(panel)
        glanceModel.stopFollowing()
        // Whatever was typed goes now. A debounce timer dies with the panel, and
        // a paragraph lost to closing the thing you wrote it in would be the
        // worst bug in here.
        scratchpadModel.flush()
        // Which surface you were on survives this; the strip does not. See
        // `DeskChrome.closed`.
        deskChrome.closed()
        // The color panel is shared and outlives whatever opened it, so a desk
        // put away with one up leaves a floating panel over an empty desktop
        // pointed at something nobody can see.
        if NSColorPanel.sharedColorPanelExists, NSColorPanel.shared.isVisible {
            NSColorPanel.shared.close()
        }
        NSLog("talaria: desk hidden on \(deskChrome.surface.name)")
        if let deskScroll { NSEvent.removeMonitor(deskScroll) }
        deskScroll = nil
        deskSwipeAccumulated = 0
        panel.orderOut(nil)
        // Back to a background app. Leaving it regular would put a Dock icon and
        // a menu bar on something meant to have neither.
        NSApp.setActivationPolicy(.accessory)
        // Back to being a background app. Leaving it regular would put a Dock
        // icon and a menu bar on a thing that is meant to have neither.
        NSApp.setActivationPolicy(.accessory)
    }

    func toggleGlanceWindow() {
        let panel = glancePanel()
        if panel.isVisible {
            hideGlance()
            return
        }
        // Top-right of whichever screen the pointer is on: out of the way of
        // what is being read, and where a widget belongs rather than a dialog.
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) })
            ?? NSScreen.main {
            let f = panel.frame
            panel.setFrameOrigin(NSPoint(
                x: screen.visibleFrame.maxX - f.width - 24,
                y: screen.visibleFrame.maxY - f.height - 24
            ))
        }
        // Ordered front without activating: the front application stays front,
        // which is the whole point — Glance is about what it is showing.
        panel.orderFrontRegardless()
        panel.invalidateShadow()
        glanceModel.startFollowing()
        watchForDismissal(panel) { [weak self] in self?.hideGlance() }
    }

    /**
     Close it when attention goes elsewhere.

     A non-activating panel never becomes key, so none of the ordinary
     did-resign-key machinery ever fires — the window has no idea it stopped
     being looked at. Two monitors instead: a global one for a click in any
     other application, and a local one for Escape and for clicks landing in
     Talaria's own windows.

     Deliberately not on focus changes. Glance is *about* the front window, and
     dismissing it every time the front window changed would close it at the
     exact moment it had something new to say.
     */
    private func watchForDismissal(
        _ panel: NSPanel,
        dismissOnEscape: Bool = true,
        onHide: @escaping @MainActor () -> Void
    ) {
        stopWatchingForDismissal(panel)
        /**
         A modal is a conversation this panel started.

         Opening a file panel from the desk hid the desk: the panel is a window
         of its own, so the first click in it looked exactly like a click
         somewhere else. The picture then arrived on a canvas nobody could see,
         and getting back to it meant the hotkey and a swipe.

         `NSApp.modalWindow` is set for as long as `runModal` is running, which
         covers the file panel and every other modal without either of them
         having to know this code exists. Erring toward staying, like the menu
         case below: a panel that fails to dismiss costs a keystroke, and one
         that vanishes mid-interaction takes the interaction with it.
         */
        /**
         Windows this panel opened, which a click in is not a click away from.

         A modal — `NSApp.modalWindow` is set for as long as `runModal` runs,
         which covers the file panel.

         And the color panel, which is not modal at all: it is a shared floating
         panel, so nothing about the app's state says it is up. Opening a color
         well from the canvas inspector therefore hid the desk, exactly as the
         file panel did, and the eyedropper made it worse — the dropper takes
         over the screen, so the click that picks a color is a click in another
         app as far as the global monitor is concerned. Both are answered by
         asking whether the panel is on screen at all, rather than by trying to
         classify the click.
         */
        let modalUp = { NSApp.modalWindow != nil }
        /// The color panel is up somewhere, which matters to the global
        /// monitor: the eyedropper takes over the screen, so the click that
        /// picks a color lands in another application.
        let pickingColor = { NSColorPanel.sharedColorPanelExists && NSColorPanel.shared.isVisible }
        let global = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { _ in
            guard !modalUp(), !pickingColor() else { return }
            Task { @MainActor in onHide() }
        }
        let local = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) {
            event in
            // A click *in* the color panel, specifically — not "any click
            // while it happens to be open". Suppressing everything would mean a
            // panel left open makes the desk undismissable, and the only way to
            // close the panel is through the desk.
            if modalUp() || event.window is NSColorPanel { return event }
            if event.type == .keyDown {
                // 53 is Escape. Swallowed, so it does not also reach whatever is
                // behind — dismissing a panel should not cancel a dialog too.
                guard event.keyCode == 53, dismissOnEscape else { return event }
                Task { @MainActor in onHide() }
                return nil
            }
            // A click inside is somebody using it, not leaving it. Sheets and
            // menus belonging to the panel count as inside.
            if event.window === panel || event.window?.parent === panel { return event }
            // So does a menu. A pop-up button — the model picker in Settings is
            // one — puts its list in a window AppKit owns rather than in a child
            // of the panel, so neither test above catches it and choosing an
            // item would dismiss the panel you were choosing it *for*.
            //
            // Matched by class name because there is no public type to compare
            // against, and deliberately erring toward "inside": a panel that
            // fails to dismiss is a keystroke's inconvenience, while one that
            // vanishes mid-interaction takes the half-typed form with it.
            if let name = event.window?.className, name.contains("Menu") { return event }
            Task { @MainActor in onHide() }
            return event
        }
        dismissMonitors[ObjectIdentifier(panel)] = (global, local)
    }

    private func stopWatchingForDismissal(_ panel: NSPanel) {
        guard let (global, local) = dismissMonitors.removeValue(forKey: ObjectIdentifier(panel)) else { return }
        if let global { NSEvent.removeMonitor(global) }
        if let local { NSEvent.removeMonitor(local) }
    }

    private func hideGlance() {
        guard let panel = glanceWindow else { return }
        stopWatchingForDismissal(panel)
        glanceModel.stopFollowing()
        panel.orderOut(nil)
    }

    private func hideBoard() {
        guard let panel = boardWindow else { return }
        stopWatchingForDismissal(panel)
        panel.orderOut(nil)
    }

    private func hideAssistant() {
        guard let panel = assistantWindow else { return }
        stopWatchingForDismissal(panel)
        panel.orderOut(nil)
    }

    /**
     A titled panel, and why none of them use `.fullSizeContentView`.

     They did. It is what lets the material run the whole height of a window
     rather than stopping at a gray strip, and that is genuinely the nicer look
     — but it puts the content view over the title bar's own, and the content
     view here is an `NSVisualEffectView` that paints. The result was a title
     nobody could read and three traffic lights that were present in the
     accessibility tree, invisible on screen, and impossible to click. A window
     you cannot close or drag is not worth a seam you would not have noticed.

     The body stays translucent regardless: that comes from the effect view in
     the content, not from the style mask.

     The settings panel.

     Wears the same material as everything else and deliberately not the same
     dismissal. Glance, the board and the assistant all close on a click
     elsewhere, which is right for something summoned by a hotkey and cheap to
     summon again. This one holds half-typed text — you go to a browser to copy
     an access key out of Hermes and come back — so a panel that vanished while
     you fetched the thing it was asking for would be losing exactly the work it
     requested.
     */
    private func settingsPanel() -> NSPanel {
        if let w = settingsWindow { return w }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 620),
            styleMask: [.titled, .closable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "Talaria Settings"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        // Clear would leave the title bar painted by nothing at all.
        //
        // The content view stops at the title bar now, so whatever the *window*
        // draws is what shows up there — and a clear window draws nothing, which
        // is why the Collections title was legible against a plain desktop and
        // see-through over a document. Not opaque, so the effect view in the
        // content can still sample what is behind it; just not empty.
        //
        // Glance is deliberately not in this list: it is borderless, has no
        // title bar to paint, and takes its rounded shape from the masked effect
        // view — a window background there would square off the corners.
        panel.backgroundColor = .windowBackgroundColor
        panel.contentViewController = NSHostingController(
            rootView: SettingsView(model: settingsModel)
        )
        panel.setFrameAutosaveName("talaria.settings")
        panel.center()
        settingsWindow = panel
        return panel
    }

    private func showSettingsWindow() {
        let panel = settingsPanel()
        // Re-read from disk, but never over unsaved typing.
        //
        // Both halves matter. The file is editable by hand and by `talaria`, so
        // a panel showing what was on disk an hour ago would save it back over
        // whatever has happened since — hence the reload. But this panel now
        // closes on a click elsewhere, and going to a browser to copy an access
        // key out of Hermes *is* a click elsewhere: reloading unconditionally
        // would throw away the half-filled form at exactly the moment somebody
        // left to fetch the thing it was asking for.
        if !settingsModel.dirty { settingsModel.load() }
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) {
            let f = panel.frame
            panel.setFrameOrigin(NSPoint(
                x: screen.visibleFrame.midX - f.width / 2,
                y: screen.visibleFrame.midY - f.height / 2
            ))
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        watchForDismissal(panel) { [weak self] in self?.hideSettings() }
    }

    private func hideSettings() {
        guard let panel = settingsWindow else { return }
        stopWatchingForDismissal(panel)
        panel.orderOut(nil)
    }

    /**
     Composing a new block.

     Titled and keyed, like the assistant and unlike Glance: this is a thing you
     type into at length, so it takes focus and keeps it. It does *not* dismiss
     on a click elsewhere — half a filled-in form is exactly the kind of work
     that should survive going to another window to check a date.
     */
    private func composePanel() -> NSPanel {
        if let w = composeWindow { return w }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Field.formWidth, height: 560),
            // Resizable, which it was not. A form that has been made too small
            // to hold its own fields and cannot be dragged wider again is a
            // window somebody is simply stuck in.
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "New Block"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .windowBackgroundColor
        panel.contentViewController = NSHostingController(
            rootView: ComposeView(model: composeModel) { [weak self] title, id in
                MainActor.assumeIsolated {
                    self?.hideCompose()
                    // Whatever asked for this composer gets told what it made,
                    // once. A canvas node waiting to be linked is the only
                    // caller today, and it must not be told about a block the
                    // *next* thing somebody composes.
                    let waiting = self?.composeHandoff
                    self?.composeHandoff = nil
                    if let waiting, let id { waiting(id) }
                    Task { await Self.notify(title: "Created", body: title) }
                }
            }
        )
        // Enforced by AppKit as well as declared in SwiftUI, because the
        // restored frame below is applied by AppKit and would otherwise not be
        // checked against anything.
        panel.contentMinSize = NSSize(width: Field.formWidth, height: 320)
        panel.setFrameAutosaveName("talaria.compose")
        // A frame saved by an earlier build can be smaller than the form can be
        // drawn, and restoring it would put the window straight back into the
        // state this is fixing — a saved size outlives the bug that made it.
        //
        // Height as well as width, and for the same cause rather than for
        // tidiness: a hosting controller sizes its window to the *minimum* the
        // view will accept, so the panel opened at 320 points of content and
        // the autosave kept it. A form pinned to its own floor in both
        // directions is not a size anybody chose.
        //
        // Only when it is sitting exactly on the floor. A window somebody has
        // deliberately made small is theirs, and restoring 560 over the top of
        // that would be this code overruling a person about their own window.
        let content = panel.contentRect(forFrameRect: panel.frame)
        if content.width < Field.formWidth || content.height <= 320 {
            panel.setContentSize(NSSize(width: max(content.width, Field.formWidth),
                                        height: content.height <= 320 ? 560 : content.height))
        }
        panel.center()
        composeWindow = panel
        return panel
    }

    /**
     Open the composer with something in it, and hear back what it made.

     For a canvas node becoming a Hermes block. The seed is the node's own words;
     the composer already knows what to do with them — first line into the field
     the type leads with, the rest into its body — which is the same rule it
     applies to a selection taken from any other application.
     */
    func compose(seed: String, then: @escaping (String) -> Void) {
        composeHandoff = then
        let panel = composePanel()
        composeModel.load(seed: seed)
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) {
            let f = panel.frame
            panel.setFrameOrigin(NSPoint(
                x: screen.visibleFrame.midX - f.width / 2,
                y: screen.visibleFrame.maxY - f.height - 100
            ))
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    private func toggleComposeWindow() {
        let panel = composePanel()
        if panel.isVisible {
            hideCompose()
            return
        }
        // Read before activating. Showing the panel makes Talaria frontmost, and
        // by then the only selection anywhere is whatever is in this window.
        composeModel.load(seed: Focused.selection(allowCopy: true))
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) {
            let f = panel.frame
            panel.setFrameOrigin(NSPoint(
                x: screen.visibleFrame.midX - f.width / 2,
                y: screen.visibleFrame.maxY - f.height - 100
            ))
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    private func hideCompose() {
        composeWindow?.orderOut(nil)
    }

    /// The assistant panel.
    ///
    /// Non-activating would be wrong here: it exists to be typed into, so it
    /// takes focus and gives it back on Escape.
    ///
    /// Dismissed by a click elsewhere like the other two, and it costs less
    /// here than anywhere: the panel is never released, so a conversation
    /// closed mid-sentence is exactly where you left it when the hotkey brings
    /// it back.
    private func assistantPanel() -> NSPanel {
        if let w = assistantWindow { return w }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 420),
            styleMask: [.titled, .closable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "Ask Hermes Notes"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        // Same material as the other two. Titled and keyed rather than
        // borderless and non-activating, because this one exists to be typed
        // into — a prompt that cannot take the cursor is not a prompt.
        panel.isOpaque = false
        // Clear would leave the title bar painted by nothing at all.
        //
        // The content view stops at the title bar now, so whatever the *window*
        // draws is what shows up there — and a clear window draws nothing, which
        // is why the Collections title was legible against a plain desktop and
        // see-through over a document. Not opaque, so the effect view in the
        // content can still sample what is behind it; just not empty.
        //
        // Glance is deliberately not in this list: it is borderless, has no
        // title bar to paint, and takes its rounded shape from the masked effect
        // view — a window background there would square off the corners.
        panel.backgroundColor = .windowBackgroundColor
        panel.contentViewController = NSHostingController(
            rootView: AssistantView(model: assistantModel).background(VisualEffect(radius: 0))
        )
        panel.setFrameAutosaveName("talaria.assistant")
        panel.center()
        assistantWindow = panel
        return panel
    }

    private func toggleAssistantWindow() {
        let panel = assistantPanel()
        if panel.isVisible {
            hideAssistant()
            return
        }
        // Near the top of whichever screen the pointer is on — where a prompt
        // belongs, rather than dead center over whatever is being read.
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) {
            let f = panel.frame
            panel.setFrameOrigin(NSPoint(
                x: screen.visibleFrame.midX - f.width / 2,
                y: screen.visibleFrame.maxY - f.height - 120
            ))
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        watchForDismissal(panel) { [weak self] in self?.hideAssistant() }
    }

    /// A string setting from config.json, if it names one.
    private static func configured(_ key: String) -> String? {
        let path = NSHomeDirectory() + "/Library/Application Support/Talaria/config.json"
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = obj[key] as? String, !value.isEmpty
        else { return nil }
        return value
    }

    /// A window rather than a popover.
    ///
    /// A popover anchors to the status item, which is exactly the thing that may
    /// not be on screen. A panel opens wherever it likes, takes focus properly
    /// so dragging works, and closes on Escape.
    private func boardPanel() -> NSPanel {
        if let w = boardWindow { return w }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 620),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "Hermes Notes Collections"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        // The same material as Glance, and for the same reason: a window that
        // carries the color of what is behind it reads as part of the machine
        // rather than as a thing an application put on the screen.
        //
        // Still titled, still resizable — unlike Glance this is somewhere you
        // work, a matrix needs room, and how much room depends on how many
        // regions there are. Chromeless would cost the close button and the
        // resize edges to buy a look.
        panel.isOpaque = false
        // Clear would leave the title bar painted by nothing at all.
        //
        // The content view stops at the title bar now, so whatever the *window*
        // draws is what shows up there — and a clear window draws nothing, which
        // is why the Collections title was legible against a plain desktop and
        // see-through over a document. Not opaque, so the effect view in the
        // content can still sample what is behind it; just not empty.
        //
        // Glance is deliberately not in this list: it is borderless, has no
        // title bar to paint, and takes its rounded shape from the masked effect
        // view — a window background there would square off the corners.
        panel.backgroundColor = .windowBackgroundColor
        panel.contentViewController = NSHostingController(
            rootView: BoardView(model: boardModel).background(VisualEffect(radius: 0))
        )
        // Big enough that the whole grid is on screen at once, which is the
        // point of a matrix — and resizable, since how much fits depends on how
        // many regions there are and how full they get.
        panel.setContentSize(NSSize(width: 900, height: 620))
        panel.minSize = NSSize(width: 520, height: 380)
        panel.setFrameAutosaveName("talaria.board")
        panel.center()
        boardWindow = panel
        return panel
    }

    private func toggleBoardWindow() {
        let panel = boardPanel()
        if panel.isVisible {
            hideBoard()
            return
        }
        boardModel.load()
        // Where the pointer is, so it opens on the screen being used rather
        // than on whichever one macOS thinks is main.
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) {
            let f = panel.frame
            panel.setFrameOrigin(NSPoint(
                x: screen.visibleFrame.midX - f.width / 2,
                y: screen.visibleFrame.midY - f.height / 2
            ))
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        // Dismissed by a click elsewhere, like Glance. Worth knowing the cost:
        // this is a window somebody works in, so stepping into another
        // application to check something closes it, and the hotkey brings it
        // back. The right trade for a thing summoned by a hotkey and the wrong
        // one for a document, which is why nothing else here does it.
        watchForDismissal(panel) { [weak self] in self?.hideBoard() }
    }

    @objc private func toggleBoard(_ sender: NSStatusBarButton) {
        // Right-click is the way out of an app with no menu bar.
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            let open = menu.addItem(withTitle: "Open Hermes Notes", action: #selector(showHermes), keyEquivalent: "")
            open.target = self
            open.image = NSImage(systemSymbolName: "macwindow", accessibilityDescription: nil)
            menu.addItem(.separator())
            let ask = menu.addItem(withTitle: "Ask Hermes Notes", action: #selector(showAssistant), keyEquivalent: "")
            ask.target = self
            ask.image = NSImage(systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: nil)
            let webCanvas = menu.addItem(withTitle: "Canvas (web preview)", action: #selector(showWebCanvas), keyEquivalent: "")
            webCanvas.target = self
            let coll = menu.addItem(withTitle: "Hermes Notes Collections", action: #selector(showBoard), keyEquivalent: "")
            coll.target = self
            coll.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: nil)
            let glance = menu.addItem(withTitle: "Glance", action: #selector(showGlance), keyEquivalent: "")
            glance.target = self
            glance.image = NSImage(systemSymbolName: "sparkle.magnifyingglass", accessibilityDescription: nil)
            let compose = menu.addItem(withTitle: "New Block…", action: #selector(showCompose), keyEquivalent: "n")
            compose.target = self
            compose.image = NSImage(systemSymbolName: "square.and.pencil", accessibilityDescription: nil)

            menu.addItem(.separator())
            // Which of the two a plain click opens. A menu bar item has exactly
            // one left click to give, and which one you want depends on how you
            // work — so it is a choice rather than my guess.
            let submenu = NSMenu()
            for (title, value) in Self.primaryChoices {
                let item = submenu.addItem(withTitle: title, action: #selector(setPrimary(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = value
                item.state = (Self.primaryPanel == value) ? .on : .off
            }
            let picker = menu.addItem(withTitle: "Click opens", action: nil, keyEquivalent: "")
            menu.setSubmenu(submenu, for: picker)

            menu.addItem(.separator())
            let settings = menu.addItem(withTitle: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
            settings.target = self
            settings.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)
            menu.addItem(withTitle: "Refresh", action: #selector(refreshBoard), keyEquivalent: "r").target = self
            menu.addItem(withTitle: "Quit Talaria", action: #selector(quit), keyEquivalent: "q").target = self
            statusItem?.menu = menu
            statusItem?.button?.performClick(nil)
            statusItem?.menu = nil
            return
        }
        switch Self.primaryPanel {
        case "assistant": toggleAssistantWindow()
        case "glance": toggleGlanceWindow()
        case "compose": toggleComposeWindow()
        default: toggleBoardWindow()
        }
    }

    /// What a plain click can be set to open. A menu bar item has exactly one
    /// left click to give, and which surface deserves it depends on how somebody
    /// works — so it is a choice rather than my guess.
    private static let primaryChoices: [(String, String)] = [
        ("Hermes Notes Collections", "board"),
        ("Ask Hermes Notes", "assistant"),
        ("Glance", "glance"),
        ("New Block", "compose"),
    ]

    /// Which panel a left click opens, remembered between launches.
    private static var primaryPanel: String {
        UserDefaults.standard.string(forKey: "talaria.primaryPanel") ?? "board"
    }

    @objc private func setPrimary(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? String else { return }
        UserDefaults.standard.set(value, forKey: "talaria.primaryPanel")
    }

    @objc private func showBoard() { toggleBoardWindow() }

    @objc private func showGlance() { toggleGlanceWindow() }

    @objc private func showSettings() { showSettingsWindow() }

    @objc private func showCompose() { toggleComposeWindow() }

    @objc private func showHermes() { HermesWindow.shared.show() }

    /// The canvas as a web view — alongside the desk's own, not instead of it,
    /// until it can do what that one does.
    @objc private func showWebCanvas() { CanvasWebWindow.shared.show() }

    /// The menu's Refresh, which means the same thing the board's own does:
    /// read the library again, then draw it. Both called `load()` before, which
    /// redrew the mirror and looked like a refresh that had nothing to say.
    @objc private func refreshBoard() { boardModel.reload() }

    @objc private func showAssistant() { toggleAssistantWindow() }

    @objc private func quit() {
        daemon?.stop()
        NSApp.terminate(nil)
    }

    // MARK: The Services menu

    /// Selected text, from any app, becoming a task.
    ///
    /// The signature is fixed by the Services machinery: this exact shape, with
    /// `@objc`, or the menu item does nothing and says nothing about why.
    @objc func captureAsTask(_ pboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        capture(pboard, as: "task", error: error)
    }

    @objc func captureAsNote(_ pboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        capture(pboard, as: "note", error: error)
    }

    /// Selected text, from any app, becoming a block.
    ///
    /// The two selectors above exist because the Services machinery dispatches
    /// by name and each menu item needs its own; the work is the same and the
    /// difference — where the pieces of the text land — is the daemon's to make.
    private func capture(_ pboard: NSPasteboard, as kind: String, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        guard let text = pboard.string(forType: .string),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error.pointee = "There was no text to capture." as NSString
            return
        }
        // Off the main thread: a Service call blocks the app that invoked it,
        // and that app should not be waiting on our network.
        Task.detached(priority: .userInitiated) {
            do {
                let made = try Daemon.capture(text, as: kind)
                await Self.notify(
                    title: made.applied ? "\(kind == "note" ? "Note" : "Task") created" : "Queued",
                    body: made.applied
                        ? made.title
                        : "\(made.title) — Hermes wasn't reachable; it will go out on reconnect."
                )
            } catch {
                await Self.notify(title: "Couldn't capture that", body: "\(error)")
            }
        }
    }

    /// Say something, because a Service that silently succeeds is
    /// indistinguishable from one that silently failed.
    @MainActor
    private static func notify(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { err in
            if let err { NSLog("talaria: \(title) — \(body) (notification failed: \(err))") }
        }
    }

    // MARK: Opening things

    /// `talaria://block/<uuid>` and `talaria://collection/<uuid>`.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { open(url) }
    }

    private func open(_ url: URL) {
        /*
         Every surface, by name.

         The status item is the only visible entrance this app has, and macOS
         drops status items it has no room for: on a notched Mac with a busy
         menu bar ours is the newest and so the first to go. The three panels
         have hotkeys for that reason, and a hotkey is not addressable — nothing
         can hand one to Alfred, a Shortcut or a script. These are, and they cost
         four lines.

         Toggles rather than shows, for the three that have a hotkey, so the URL
         and the key do the same thing rather than two subtly different things.
         Settings is show-only: it is the one you go to deliberately, and there
         is no second way to have opened it by accident.
         */
        switch url.host {
        case "settings": showSettingsWindow(); return
        case "glance": toggleGlanceWindow(); return
        case "new", "compose": toggleComposeWindow(); return
        case "collections", "board": toggleBoardWindow(); return
        case "chat", "assistant", "ask": toggleAssistantWindow(); return
        default: break
        }
        // talaria://block/<uuid> — host is "block", path is "/<uuid>"
        let id = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !id.isEmpty else {
            NSLog("talaria: nothing to open in \(url)")
            return
        }
        openBlock(id)
    }

    /// Resolve through the daemon, so the host is never baked into a link.
    private func openBlock(_ id: String) {
        Task.detached(priority: .userInitiated) {
            do {
                guard let web = try Daemon.webURL(forBlock: id) else {
                    NSLog("talaria: no web address for \(id)")
                    return
                }
                await MainActor.run { Opener.open(web) }
            } catch {
                NSLog("talaria: could not resolve \(id) — \(error)")
            }
        }
    }

    /// A Spotlight result being activated. This does NOT arrive as a URL —
    /// macOS hands back the item's identifier, which for us is the block id.
    func application(_ application: NSApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([any NSUserActivityRestoring]) -> Void) -> Bool {
        guard userActivity.activityType == CSSearchableItemActionType,
              let id = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String
        else { return false }
        openBlock(id)
        return true
    }
}

// MARK: - Entry

// A one-shot mode for the CLI and for testing, so the index can be rebuilt or
// emptied without waiting on the poll.
let args = CommandLine.arguments.dropFirst()
if args.first == "--search" {
    let term = args.dropFirst().joined(separator: " ")
    let sem = DispatchSemaphore(value: 0)
    Task {
        do {
            let hits = try await Indexer.search(term)
            print("\(hits.count) hit(s) in the Spotlight index")
            for h in hits.prefix(10) { print("  \(h.title)  [\(h.id)]") }
        } catch {
            FileHandle.standardError.write("talaria: \(error)\n".data(using: .utf8)!)
            exit(1)
        }
        sem.signal()
    }
    sem.wait()
    exit(0)
}
if args.first == "--index" || args.first == "--clear" {
    let clearing = args.first == "--clear"
    let sem = DispatchSemaphore(value: 0)
    Task {
        do {
            if clearing {
                try await Indexer.clear()
                print("index cleared")
            } else {
                let payload = try Daemon.spotlight()
                try await Indexer.reindex(payload)
                print("indexed \(payload.count) items (cursor \(payload.epoch ?? "—"))")
            }
        } catch {
            FileHandle.standardError.write("talaria: \(error)\n".data(using: .utf8)!)
            exit(1)
        }
        sem.signal()
    }
    sem.wait()
    exit(0)
}

// Top-level code is not main-actor isolated on its own, and everything below
// touches AppKit — which only ever runs here.
/// The delegate, held here for the life of the process.
///
/// NSApplication keeps its delegate *weakly*. Held in a local — even one whose
/// scope wraps `run()` — it was being released, and a released delegate is
/// simply never called: AppKit came up with its event thread and its main loop,
/// applicationDidFinishLaunching never fired, and the log stayed empty while
/// the process sat there looking perfectly healthy. The earlier attempt to pin
/// it with an associated object used a Swift string literal as the key, which
/// is a temporary pointer, so it pinned nothing reliably — which is why this
/// failed under launchd and not from a shell.
private var appDelegate: AppDelegate?

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    appDelegate = delegate
    app.delegate = delegate
    // Regular, not accessory: this app has a Dock tile people pin, a web view
    // and a menu bar. Info.plist explains why switching at runtime did not work.
    app.setActivationPolicy(.regular)
    app.run()
}
