import Foundation

/// Talking to the daemon.
///
/// Over `curl` rather than a hand-rolled socket client, deliberately. Foundation
/// has no Unix-socket transport, so the alternative is framing HTTP by hand over
/// an `NWConnection` — a hundred lines of the exact kind of code this shell is
/// supposed not to contain (brief §3: keep Swift dumb, because Swift is the part
/// that is slow to iterate on). `curl` is present on every Mac, and the command
/// it runs is the same one a person would type to debug this by hand.
enum Daemon {
    static let socketPath = NSHomeDirectory() + "/Library/Application Support/Talaria/talaria.sock"

    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static func get(_ path: String) throws -> Data {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        task.arguments = ["-s", "--fail", "--unix-socket", socketPath, "http://talaria" + path]
        let out = Pipe()
        task.standardOutput = out
        task.standardError = Pipe()
        try task.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            throw Failure(description: "daemon not answering on \(socketPath) (curl exit \(task.terminationStatus))")
        }
        return data
    }

    struct Health: Decodable {
        let cursor: Int
        let blocks: Int
        let freshness: String
    }

    struct Item: Decodable {
        let id: String
        let title: String
        let description: String
        let subtitle: String
        let kind: String
        let typeName: String
        let tags: [String]
        let url: String
        let appUrl: String
        let createdAt: String
        let updatedAt: String
    }

    struct SpotlightPayload: Decodable {
        let epoch: Int
        let count: Int
        let items: [Item]
    }

    struct Captured: Decodable {
        let title: String
        let applied: Bool
        let storedProse: Bool
    }

    /// Hand text to the daemon and let it decide where the pieces go.
    static func capture(_ text: String, as kind: String) throws -> Captured {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        task.arguments = [
            "-s", "--fail", "--unix-socket", socketPath,
            "-H", "content-type: application/json",
            // The text goes in a file rather than on the command line: a
            // selection can be long, and anything with a newline or a quote in
            // it should not be going anywhere near argv.
            "--data-binary", "@-",
            "http://talaria/capture",
        ]
        let stdin = Pipe(), out = Pipe()
        task.standardInput = stdin
        task.standardOutput = out
        task.standardError = Pipe()
        try task.run()
        let payload = try JSONSerialization.data(withJSONObject: ["text": text, "as": kind])
        stdin.fileHandleForWriting.write(payload)
        stdin.fileHandleForWriting.closeFile()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            throw Failure(description: "the daemon refused the capture (curl exit \(task.terminationStatus))")
        }
        return try JSONDecoder().decode(Captured.self, from: data)
    }

    // MARK: Boards

    struct BoardSummary: Decodable { let id: String; let title: String; let kind: String? }
    struct Region: Decodable { let index: Int; let title: String; let color: String? }
    struct Card: Decodable, Identifiable, Hashable {
        let id: String
        let title: String
        let kind: String
        let typeName: String
        let done: Bool
        let due: String?
        let tags: [String]
        let url: String
        /// Where it sits on a canvas, and how big; nil on every other kind.
        let x: Double?
        let y: Double?
        let w: Double?
        let h: Double?
    }

    struct StickyNote: Decodable, Identifiable {
        let id: String
        let text: String
        let x: Double
        let y: Double
        let w: Double
        let h: Double
        let color: String?
    }
    struct Edge: Decodable { let from: String; let to: String; let dashed: Bool }
    struct Board: Decodable {
        let id: String
        let title: String
        let cols: Int
        let rows: Int
        let regions: [Region]
        let cells: [String: [Card]]
        /// Matched by the collection's query but not placed in a region yet.
        let drawer: [Card]
        /// Whether a query governs membership at all.
        let smart: Bool
        /// What kind of collection this is — "matrix", "list", "calendar"…
        let kind: String?
        /// Matrix and kanban get a grid; everything else is a sequence.
        let gridded: Bool
        /// The contents, when it isn't gridded.
        let members: [Card]
        /// A canvas draws its members at coordinates, with notes and links.
        let canvas: Bool
        let notes: [StickyNote]
        let edges: [Edge]
    }
    private struct Envelope<T: Decodable>: Decodable {
        let data: T
        let freshness: String
        let note: String
    }

    static func boards() throws -> [BoardSummary] {
        try JSONDecoder().decode(Envelope<[BoardSummary]>.self, from: get("/boards")).data
    }

    static func board(_ id: String) throws -> (board: Board, freshness: String, note: String) {
        let e = try JSONDecoder().decode(Envelope<Board>.self, from: get("/board/\(id)"))
        return (e.data, e.freshness, e.note)
    }

    /// A write, through the daemon's own queueing path — so a card dragged with
    /// the network down still moves, and goes out on reconnect.
    static func write(_ body: [String: Any]) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        task.arguments = [
            "-s", "--fail-with-body", "--unix-socket", socketPath,
            "-H", "content-type: application/json", "--data-binary", "@-",
            "http://talaria/write",
        ]
        let stdin = Pipe(), out = Pipe()
        task.standardInput = stdin
        task.standardOutput = out
        task.standardError = Pipe()
        try task.run()
        stdin.fileHandleForWriting.write(try JSONSerialization.data(withJSONObject: body))
        stdin.fileHandleForWriting.closeFile()
        _ = out.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        // 202 means queued, which is a success from here: the daemon has it.
        guard task.terminationStatus == 0 || task.terminationStatus == 22 else {
            throw Failure(description: "the write didn't go through (curl exit \(task.terminationStatus))")
        }
    }

    // MARK: The agenda

    struct FeedEvent: Decodable {
        let uid: String
        let summary: String
        let location: String
        let start: String
        let allDay: Bool
        let feedName: String
        let color: String
    }
    struct AgendaItem: Decodable {
        let id: String
        let title: String
        let kind: String
        let typeName: String
        let done: Bool
        let at: String?
        let isEnd: Bool
        let url: String
    }
    struct AgendaDay: Decodable {
        let date: String
        let items: [AgendaItem]
        let events: [FeedEvent]
    }
    struct Agenda: Decodable {
        let types: [String]
        let feedStale: Bool
        let days: [AgendaDay]
    }

    static func agenda(days: Int) throws -> Agenda {
        try JSONDecoder().decode(Envelope<Agenda>.self, from: get("/agenda?days=\(days)")).data
    }

    // MARK: The assistant

    struct PendingCall: Decodable, Encodable { let tool: String }
    /// One tool the assistant ran, and how it went.
    struct Step: Decodable {
        let tool: String
        let ok: Bool?
        let result: String?
    }
    private struct Turn: Decodable {
        let ok: Bool?
        let reply: String?
        let pending: [PendingCall]?
        let steps: [Step]?
        let error: String?
    }
    struct AssistantTurn { let reply: String; let pending: [PendingCall]; let steps: [Step] }

    static func assistant(_ message: String) throws -> AssistantTurn {
        let data = try post("/assistant", ["message": message])
        let t = try JSONDecoder().decode(Turn.self, from: data)
        if let err = t.error { throw Failure(description: err) }
        return AssistantTurn(reply: t.reply ?? "", pending: t.pending ?? [], steps: t.steps ?? [])
    }

    @discardableResult
    static func assistantConfirm(_ calls: [PendingCall]) throws -> [Step] {
        let payload = calls.map { ["tool": $0.tool] }
        let data = try post("/assistant/confirm", ["calls": payload])
        let t = try JSONDecoder().decode(Turn.self, from: data)
        if let err = t.error { throw Failure(description: err) }
        return t.steps ?? []
    }

    /// POST JSON, and give back the body whatever the status — the daemon puts
    /// its explanation in there, and losing it to a bare status code is how a
    /// clear message becomes "something went wrong".
    private static func post(_ path: String, _ body: [String: Any]) throws -> Data {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        task.arguments = [
            "-s", "--unix-socket", socketPath,
            "-H", "content-type: application/json", "--data-binary", "@-",
            "http://talaria" + path,
        ]
        let stdin = Pipe(), out = Pipe()
        task.standardInput = stdin
        task.standardOutput = out
        task.standardError = Pipe()
        try task.run()
        stdin.fileHandleForWriting.write(try JSONSerialization.data(withJSONObject: body))
        stdin.fileHandleForWriting.closeFile()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            throw Failure(description: "the daemon isn't answering (curl exit \(task.terminationStatus))")
        }
        return data
    }

    static func health() throws -> Health {
        try JSONDecoder().decode(Health.self, from: get("/health"))
    }

    static func spotlight() throws -> SpotlightPayload {
        try JSONDecoder().decode(SpotlightPayload.self, from: get("/spotlight"))
    }

    /// The web address for a block id, asked of the daemon rather than built here.
    ///
    /// This is the whole point of `talaria://` over a baked-in https link: the
    /// host lives in one config file, so a link pasted into a note two years ago
    /// still opens after Hermes has moved.
    static func webURL(forBlock id: String) throws -> URL? {
        let data = try get("/blocks/\(id)")
        struct Envelope: Decodable { struct Data: Decodable { let url: String }; let data: Data }
        let env = try JSONDecoder().decode(Envelope.self, from: data)
        return URL(string: env.data.url)
    }
}
