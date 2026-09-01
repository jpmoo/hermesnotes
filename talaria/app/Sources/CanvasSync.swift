import Foundation

/**
 The canvas, kept in step with the collection that backs it.

 **The local file stays the working document.** That is the decision the rest of
 this follows from. A drag writes `canvas.json` and returns, the way it always
 has — instant, offline, and unchanged by any of this. Making the network the
 place a canvas lives would mean a drag that waits on a socket, and a canvas
 that is empty until something answers.

 So the sync sits beside the document rather than under it: pushes are debounced
 and sent off the main thread, and pulls arrive on the same cursor tick that
 already tells the desk when Hermes has moved. If the daemon is down, the canvas
 carries on exactly as before and the queue sends the work when it comes back.

 **What is pushed is the whole arrangement**, not a gesture. Which node moved is
 worked out at the far end against the mirror's copy, so nothing here has to
 track dirty state, and a push that is lost costs nothing but the next one being
 the one that lands.
 */
@MainActor
final class CanvasSync {
    /// Wait this long after the last change before sending.
    ///
    /// A drag settles into several saves in quick succession — the gesture ends,
    /// a region recomputes, a selection clears — and sending each would be three
    /// writes for one motion. Long enough to collect those, short enough that
    /// letting go of a node and looking at Hermes shows it there.
    private static let quiet: TimeInterval = 0.8

    private var timer: Timer?
    private var pending: CanvasDocument?
    /// The last document we sent, so a pull that matches it is our own echo.
    private var sent: CanvasDocument?
    /// True while a push is in flight, so a pull cannot land on top of one.
    private var pushing = false
    /**
     The members this canvas has actually read.

     Sent with every push so the far end can tell a node the user deleted from
     one it has never heard of. Both are "in the collection and not in the
     document"; only the first is a removal.

     Empty until the first pull, which is deliberate — a canvas that has read
     nothing is in no position to say anything should go, and starting empty
     means the very first push after backing cannot delete what somebody else
     put there while the app was closed.
     */
    private var known: Set<String> = []

    /// Whether this canvas is backed at all. False until somebody points it at
    /// a collection, and everything here is a no-op while it is.
    private(set) var backed = false

    /// Told when a pull brought something new down.
    var onPulled: ((CanvasDocument) -> Void)?
    /// Told when we learn whether there is a collection behind this canvas.
    /// The answer arrives off a socket, so it is later than the first draw.
    var onBackedChanged: ((Bool) -> Void)?

    /// Whether anything has been read yet. Nothing is sent before it has.
    private var read = false

    init() {
        Task.detached(priority: .utility) {
            let ok = (try? Daemon.canvasBacked()) ?? false
            // Read before writing, and not as a nicety.
            //
            // The first push of a session used to go out before the first pull,
            // so the read-set was empty, every existing row looked like
            // somebody else's, and the same rows were kept *and* appended. Two
            // regions became four, then eight, once per launch.
            //
            // The far end refuses to duplicate now whatever this does, but a
            // canvas that overwrites a collection it has never looked at is
            // wrong on its own terms — what it holds is a guess until it has
            // read one.
            let first = ok ? try? Daemon.canvasPull() : nil
            await MainActor.run {
                self.backed = ok
                self.onBackedChanged?(ok)
                if let first {
                    self.read = true
                    self.sent = first
                    self.known = Set(
                        first.items.map { $0.blockId ?? $0.id.uuidString }
                            + first.links.map { $0.id.uuidString }
                            + first.regions.map { $0.id.uuidString }
                    )
                    self.onPulled?(first)
                }
                // Anything offered before we knew is sent now. Without this the
                // contents a canvas already had would wait for the next edit.
                if ok, self.pending != nil { self.flush() }
            }
        }
    }

    /// The canvas changed. Sent once it stops changing.
    func changed(_ document: CanvasDocument) {
        pending = document
        // Kept even when we do not yet know whether this canvas is backed —
        // the answer is one socket call away and dropping the document in the
        // meantime loses the one offer that carries what is already here.
        guard backed else { return }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Self.quiet, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in self?.flush() }
        }
    }

    private func flush() {
        // Never before the first read. See `init`.
        guard backed, read, let document = pending, !pushing else { return }
        pending = nil
        pushing = true
        sent = document
        let seen = known
        Task.detached(priority: .utility) {
            _ = try? Daemon.canvasPush(document, known: seen)
            await MainActor.run { self.pushing = false }
        }
    }

    /**
     Ask what the collection says now.

     Called on the mirror's own tick, which is the same signal the rest of the
     desk reloads on. Answers nothing while a push is in flight or waiting: the
     far end has not seen our newest arrangement yet, so what it would hand back
     is our own past, and applying it would drag every node the user just moved
     back to where it was.
     */
    func pull() {
        guard backed, !pushing, pending == nil else { return }
        Task.detached(priority: .utility) {
            guard let fetched = try? Daemon.canvasPull() else { return }
            await MainActor.run {
                // Our own write coming back down. The format has a section on
                // exactly this, and the cheap half of it is: if what arrived is
                // what we sent, there is nothing to apply.
                guard fetched != self.sent else { return }
                self.sent = fetched
                // Read, therefore ours to speak about. A node that leaves the
                // canvas after this point is one somebody took off it.
                //
                // Everything, not only the blocks. Notes, connectors and
                // regions are written as whole arrays at the far end, and the
                // same rule decides each of them — so a set holding only block
                // ids meant no note was ever recognized as one we had read, and
                // every push kept the old rows and appended the new ones. Five
                // notes became ten.
                self.read = true
                self.known = Set(
                    fetched.items.map { $0.blockId ?? $0.id.uuidString }
                        + fetched.links.map { $0.id.uuidString }
                        + fetched.regions.map { $0.id.uuidString }
                )
                self.onPulled?(fetched)
            }
        }
    }
}

extension Daemon {
    /// Whether the daemon has a collection to back the canvas with.
    static func canvasBacked() throws -> Bool {
        do {
            _ = try get("/canvas")
            return true
        } catch let failure as Failure where failure.answered {
            // The daemon answered and said no. That is a configuration, not a
            // failure — nobody has pointed the canvas at a collection yet.
            return false
        }
    }

    /// The canvas as the collection has it.
    static func canvasPull() throws -> CanvasDocument {
        struct Answer: Decodable { let document: CanvasDocument }
        return try JSONDecoder().decode(Envelope<Answer>.self, from: get("/canvas")).data.document
    }

    /// The canvas as it should now stand. Answers whether anything was queued.
    @discardableResult
    static func canvasPush(_ document: CanvasDocument, known: Set<String>) throws -> Bool {
        struct Answer: Decodable { let queued: Bool }
        // The document, with the read-set alongside it. Encoded by hand because
        // `known` is not part of the document and must not become a field on
        // it — what the canvas holds and what the canvas has seen are different
        // things, and a document carrying the second would write it to disk.
        var payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(document)) as? [String: Any] ?? [:]
        payload["known"] = Array(known)
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(Envelope<Answer>.self, from: postJSON("/canvas", body)).data.queued
    }
}

/// A holder, because `CanvasSync` is a plain class and a view needs something
/// SwiftUI will keep alive across redraws. It publishes nothing — the canvas
/// hears about a pull through the closure, not through a redraw.
@MainActor
final class CanvasSyncBox: ObservableObject {
    let inner = CanvasSync()
}

extension Daemon {
    /**
     Make the collection this canvas will be, or confirm the one it already is.

     Safe to call again. The id is chosen at the far end and the create is a
     create-or-confirm, so somebody who backs an already-backed canvas is told
     what it already is rather than handed a fresh empty one.
     */
    static func canvasBack(name: String) throws -> (collection: String, created: Bool) {
        struct Answer: Decodable { let collection: String; let created: Bool }
        let a = try JSONDecoder().decode(Envelope<Answer>.self, from: post("/canvas/back", ["name": name])).data
        return (a.collection, a.created)
    }
}
