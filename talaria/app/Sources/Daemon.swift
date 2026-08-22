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
