import AppKit
import CoreSpotlight
import Foundation

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

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var daemon: DaemonProcess?
    private var timer: Timer?
    private var lastIndexedEpoch = -1
    private var signalSources: [DispatchSourceSignal] = []

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

        // Poll for a moved cursor rather than reindexing on a schedule: the
        // check is one cheap call and reindexing when nothing changed is pure
        // waste. First pass is delayed so the daemon has a socket to answer on.
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.syncIndexIfChanged()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.syncIndexIfChanged() }
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
        Task.detached(priority: .background) { [weak self] in
            guard let self else { return }
            do {
                let health = try Daemon.health()
                guard health.cursor != self.lastIndexedEpoch else { return }
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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // no Dock icon, no menu bar
app.run()
