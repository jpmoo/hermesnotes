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
    struct DateBit: Decodable, Hashable {
        let text: String
        let overdue: Bool
    }
    struct Card: Decodable, Identifiable, Hashable {
        let id: String
        let title: String
        let kind: String
        let typeName: String
        let done: Bool
        let due: String?
        let tags: [String]
        let url: String
        /// The heading this belongs under, when the collection is grouped.
        let group: String?
        /// Every dated field the block has, formatted as the board shows them.
        let dates: [DateBit]?
        /// Whether this block has a status at all — a note or a person has none,
        /// and a checkbox on one is an offer of nonsense.
        ///
        /// Optional rather than required, and read through `canComplete`.
        ///
        /// Swift's synthesized decoder is all-or-nothing and does *not* fall
        /// back to a property's default — only an optional gets decodeIfPresent
        /// — so one field missing from one card in one list threw the whole
        /// board away and put a decoding error where the window should be. A
        /// payload that has drifted should cost the feature it belongs to, not
        /// the view.
        let completable: Bool?
        /// Where it sits on a canvas, and how big; nil on every other kind.
        let x: Double?
        let y: Double?
        let w: Double?
        let h: Double?

        /// Whether to offer a checkbox at all.
        var canComplete: Bool { completable ?? false }
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
    struct Edge: Decodable {
        let from: String
        let to: String
        /// Which edge of each box the line leaves and arrives at: n, s, e, w.
        let fromSide: String
        let toSide: String
        let dash: String      // solid | dashed | dotted
        let arrow: String     // none | forward | back | both
        let width: Double
        let color: String?
        let label: String?
    }
    /// A rollup node. Recursive, because a rollup is however many levels deep
    /// it was configured to be.
    struct Group: Decodable, Identifiable {
        let id: String
        let title: String
        let typeName: String
        let url: String
        let done: Bool
        let completable: Bool?
        let due: String?
        let tags: [String]
        /// The heading this belongs under, when the collection is grouped.
        let group: String?
        let children: [Group]

        var canComplete: Bool { completable ?? false }
    }
    struct Column: Decodable, Identifiable, Hashable {
        let key: String
        let label: String
        /// The width it was dragged to in the web app, if it ever was. Used as
        /// a proportion here rather than a size — the panel is a different width
        /// from the browser and should still be full.
        let width: Double?
        var id: String { key }
    }
    struct Row: Decodable, Identifiable {
        let id: String
        let cells: [String: String]
    }
    struct Board: Decodable {
        let id: String
        let title: String
        /// Where this collection lives in the web app.
        let url: String?
        let cols: Int
        let rows: Int
        let regions: [Region]
        let cells: [String: [Card]]
        /// A rollup's headings and what hangs under each.
        let rollup: Bool
        let groups: [Group]
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
        /// What the collection is grouped by, if anything.
        let groupBy: String?
        /// A table draws its configured columns rather than a list of titles.
        let table: Bool
        let columns: [Column]
        let tableRows: [Row]
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

    // MARK: Glance

    /// One hit, and how near it was.
    ///
    /// `completion` is optional and read as such: a note has no status, and a
    /// checkbox beside one is an offer of nonsense. The same all-or-nothing
    /// decoder trap as `Card` applies — a required field missing from one hit
    /// would throw away the whole panel.
    struct GlanceHit: Decodable, Identifiable {
        struct Completion: Decodable {
            let done: Bool
            let status: String?
        }

        struct When: Decodable {
            let value: String
        }

        struct Schedule: Decodable {
            let start: When?
            let end: When?
        }

        struct Block: Decodable {
            let id: String
            let title: String
            let typeName: String
            let url: String
            let completion: Completion?
            /// Absent on anything that is not dated, which is most of a library.
            let schedule: Schedule?
        }

        /**
         Whether this is worth seeing while working on something now.

         Undated things are always near. A person, a project, a note has no date
         and is not less relevant for it — that is most of what anybody wants
         while writing a letter, and demoting them would empty the useful half
         of the list to make room for tasks.

         Dated things are near if any end of them falls in the window. Both ends
         are checked because a span that started last week and ends next month
         is happening *now*, and testing only its start or only its end would
         call it past or future depending on which end you picked.
         */
        var isNear: Bool {
            guard let schedule = block.schedule else { return true }
            let dates = [schedule.start?.value, schedule.end?.value].compactMap { $0 }
            if dates.isEmpty { return true }
            let today = ISO8601DateFormatter.day.string(from: Date())
            let from = ISO8601DateFormatter.day.string(from: Date().addingTimeInterval(-7 * 86400))
            let to = ISO8601DateFormatter.day.string(from: Date().addingTimeInterval(21 * 86400))
            // String comparison is correct for ISO days and needs no parsing.
            return dates.contains { $0.prefix(10) >= from && $0.prefix(10) <= to }
                || dates.contains { $0.prefix(10) <= today }
                    && dates.contains { $0.prefix(10) >= today }
        }

        let score: Double
        let block: Block
        var id: String { block.id }
    }

    struct GlanceAnswer: Decodable {
        let data: [GlanceHit]
        let question: String?
        /// "document", "title" or "asked" — where the question came from.
        let source: String?
        let error: String?
    }

    /// Ask what the library knows about what is in front, or about `query`.
    static func glance(query: String?) throws -> GlanceAnswer {
        // More than the panel shows at rest, because the ones below the line
        // have to come from somewhere: asking for eight and splitting them
        // would leave the divider reading "1 further out" and the near list
        // looking thin. The cost is a few hundred more dot products.
        var path = "/glance?k=16"
        if let query, !query.isEmpty {
            let escaped = query.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            path += "&q=\(escaped)"
        }
        return try JSONDecoder().decode(GlanceAnswer.self, from: get(path))
    }

    /// Tick something off from wherever it is being shown.
    static func complete(id: String) throws {
        try write(["kind": "complete", "blockId": id])
    }

    // MARK: The agenda

    struct FeedEvent: Decodable {
        let uid: String
        let summary: String
        let location: String
        let start: String
        let end: String?
        let allDay: Bool
        let feedId: String
        let feedName: String
        let color: String
    }
    struct Feed: Decodable, Identifiable { let id: String; let name: String; let color: String }
    struct AgendaItem: Decodable {
        let id: String
        let title: String
        let kind: String
        let typeName: String
        let done: Bool
        let completable: Bool?
        let start: String?
        let end: String?
        let startsToday: Bool
        let endsToday: Bool
        /// What the type calls the far end of its span — "Due" on a task,
        /// nothing on an event. Present only on the day that end falls.
        let endLabel: String?
        /// The calendar feed this block was converted from, if any.
        let feedOrigin: String?
        let url: String

        var canComplete: Bool { completable ?? false }
    }
    struct AgendaDay: Decodable {
        let date: String
        let items: [AgendaItem]
        let events: [FeedEvent]
    }
    struct Agenda: Decodable {
        let types: [String]
        let feeds: [Feed]
        let feedStale: Bool
        let days: [AgendaDay]
    }

    /// - Parameter collection: scope to one collection's members. A calendar
    ///   collection is a view of what is in it, so it shows those and no
    ///   subscribed feeds — those belong to the agenda, which is a view over
    ///   everything.
    static func agenda(days: Int, date: String? = nil, collection: String? = nil) throws -> Agenda {
        var path = "/agenda?days=\(days)"
        if let date { path += "&date=\(date)" }
        if let collection { path += "&collection=\(collection)" }
        return try JSONDecoder().decode(Envelope<Agenda>.self, from: get(path)).data
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

extension ISO8601DateFormatter {
    /// `YYYY-MM-DD` in the local zone, because "is this soon" is a question
    /// about the reader's day rather than about UTC's.
    static let day: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withFullDate]
        f.timeZone = .current
        return f
    }()
}
