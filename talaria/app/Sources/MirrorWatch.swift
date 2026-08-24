import Foundation

/**
 A window shows what the mirror held when it opened, and the mirror keeps moving.

 Every view here loads once and then sits there. That is fine for a panel you
 summon and dismiss, and wrong for one left open — a board opened at seven in the
 morning still shows seven in the morning at noon, with no sign that it is a
 photograph rather than a window. It reads as "Talaria has stopped syncing", and
 the sync is fine; the picture is old.

 So: ask the daemon for its sync cursor, and tell somebody when it moves. The
 cursor is the change log's high-water mark, so it changes exactly when something
 changed and never otherwise — which is what makes this cheap enough to leave
 running and quiet enough not to reload a view somebody is using.

 Deliberately a poll rather than a push. The daemon would have to hold a socket
 open per window and notice when one goes away, and this costs a local read of
 one integer every twenty seconds.
 */
@MainActor
final class MirrorWatch {
    private var timer: Timer?
    private var lastCursor: Int?

    /// Called when the mirror has moved since the last time it was looked at.
    private let onChange: () -> Void

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
    }

    /// Begin watching. The first reading is a baseline, never a change: opening a
    /// window has just loaded it, and reloading immediately would be a flicker
    /// with nothing behind it.
    func start(interval: TimeInterval = 20) {
        stop()
        lastCursor = try? Daemon.health().cursor
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.tick() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Note where the mirror is now without reloading — for a view that has just
    /// refreshed itself and would otherwise be told to do it again.
    func markSeen() {
        lastCursor = try? Daemon.health().cursor
    }

    private func tick() {
        guard let now = try? Daemon.health().cursor else { return }
        defer { lastCursor = now }
        guard let was = lastCursor, now != was else { return }
        onChange()
    }

    deinit {
        timer?.invalidate()
    }
}
