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
        let pkg = root.appendingPathComponent("packages/daemon")
        let entry = pkg.appendingPathComponent("src/index.ts")
        guard FileManager.default.fileExists(atPath: node.path),
              FileManager.default.fileExists(atPath: entry.path) else {
            NSLog("talaria: cannot find node or the daemon — expected \(node.path) and \(entry.path)")
            return
        }
        let p = Process()
        p.executableURL = node
        // `--import tsx` rather than running tsx's CLI, which forks a second
        // process to do the actual work. That fork is what made the orphan
        // guard useless: killing this app reparented the *wrapper*, while the
        // process holding the mirror open went on believing its parent was
        // fine. One process, one parent, one thing to notice going away.
        p.arguments = ["--import", "tsx", entry.path]
        // tsx is resolved as a module specifier, so this has to be the package
        // that has it installed.
        p.currentDirectoryURL = pkg
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
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var daemon: DaemonProcess?
    private var timer: Timer?
    private var lastIndexedEpoch = -1
    private var signalSources: [DispatchSourceSignal] = []
    private var statusItem: NSStatusItem?
    private var boardWindow: NSPanel?
    private var hotkey: Hotkey?
    private let boardModel = BoardModel()

    /// Where the daemon's code lives.
    ///
    /// Read from the bundle rather than walked to from it: the app is assembled
    /// outside the repo (iCloud puts attributes on anything under ~/Documents
    /// that codesign then refuses), so its own location says nothing about where
    /// the source is. build.sh stamps the path in at assembly time.
    private var repoRoot: URL {
        if let s = Bundle.main.object(forInfoDictionaryKey: "TalariaRepoRoot") as? String, !s.isEmpty {
            return URL(fileURLWithPath: s)
        }
        NSLog("talaria: no TalariaRepoRoot in Info.plist — rebuild with build.sh")
        return URL(fileURLWithPath: NSHomeDirectory())
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let d = DaemonProcess(root: repoRoot)
        daemon = d
        installSignalHandlers()
        d.start()

        // Register as the provider for the Service declared in Info.plist, and
        // tell the pasteboard server to re-read that declaration — without the
        // update the menu item can take until the next login to appear.
        NSApp.servicesProvider = self
        NSUpdateDynamicServices()

        installStatusItem()

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

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        daemon?.stop()
    }

    /// Take the daemon down with us when we are signalled.
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
        let since = lastIndexedEpoch
        Task.detached(priority: .background) { [self] in
            do {
                let health = try Daemon.health()
                guard health.cursor != since else { return }
                let payload = try Daemon.spotlight()
                try await Indexer.reindex(payload)
                await MainActor.run { self.lastIndexedEpoch = payload.epoch }
                NSLog("talaria: indexed \(payload.count) items (epoch \(payload.epoch))")
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
            // The template flag lets macOS invert it for light and dark menu
            // bars, which a coloured icon would not survive.
            //
            // Loaded by path rather than by name: the bundle also carries a
            // compiled asset catalog, and `image(forResource:)` searching that
            // first is a good way to miss a loose file sitting next to it.
            let path = Bundle.main.bundlePath + "/Contents/Resources/MenuBar.png"
            let icon = NSImage(contentsOfFile: path) ?? Bundle.main.image(forResource: "MenuBar")
            if let icon {
                icon.isTemplate = true
                icon.size = NSSize(width: 18, height: 18)
                button.image = icon
                NSLog("talaria: status item installed with icon from \(path)")
            } else {
                button.title = "Hermes"
                NSLog("talaria: status item installed WITHOUT an icon — no MenuBar.png at \(path)")
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

        // A hotkey as well as the menu bar, and not as a convenience: macOS
        // silently drops status items that don't fit, and on a Mac with a notch
        // and a busy menu bar ours is the newest and so the first to go. An
        // entrance that can vanish without saying anything is not an entrance.
        // ctrl+opt+space is deliberately left free for the assistant panel.
        let spec = Self.configuredHotkey() ?? "ctrl+opt+b"
        hotkey = Hotkey(spec: spec) { [weak self] in self?.toggleBoardWindow() }
    }

    /// The hotkey from config.json, if it names one.
    private static func configuredHotkey() -> String? {
        let path = NSHomeDirectory() + "/Library/Application Support/Talaria/config.json"
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let spec = obj["boardHotkey"] as? String, !spec.isEmpty
        else { return nil }
        return spec
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
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Hermes"
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentViewController = NSHostingController(rootView: BoardView(model: boardModel))
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
            panel.orderOut(nil)
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
    }

    @objc private func toggleBoard(_ sender: NSStatusBarButton) {
        // Right-click is the way out of an app with no menu bar.
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(withTitle: "Refresh", action: #selector(refreshBoard), keyEquivalent: "r").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Quit Talaria", action: #selector(quit), keyEquivalent: "q").target = self
            statusItem?.menu = menu
            statusItem?.button?.performClick(nil)
            statusItem?.menu = nil
            return
        }
        toggleBoardWindow()
    }

    @objc private func refreshBoard() { boardModel.load() }

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
                let opened = await MainActor.run { NSWorkspace.shared.open(web) }
                if !opened { NSLog("talaria: nothing would open \(web)") }
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
                print("indexed \(payload.count) items (epoch \(payload.epoch))")
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
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    // Keep the delegate alive: NSApplication holds it weakly.
    objc_setAssociatedObject(app, "talaria.delegate", delegate, .OBJC_ASSOCIATION_RETAIN)
    app.setActivationPolicy(.accessory) // no Dock icon, no menu bar
    app.run()
}
