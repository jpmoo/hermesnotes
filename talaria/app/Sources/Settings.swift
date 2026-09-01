import Foundation

/**
 The settings file, and the two questions a person needs answered while editing it.

 Talaria's configuration has always been a JSON file somebody edits by hand and a
 daemon that refuses to start if they get it wrong — which is a fine arrangement
 for the person who wrote it and a poor one for everybody else. The file stays
 (it is what the daemon reads, and a config you can `cat` is worth keeping) but
 hand-editing it stops being the way in.

 Two things make that awkward, and both are answered here rather than in the
 daemon.

 **A daemon with no config never starts.** `loadConfig` exits 78 before the
 socket is bound, so on a fresh machine there is nothing listening — and a
 settings panel that could only speak through the daemon would be unable to do
 the one job it exists for. So the app reads and writes the file itself, and asks
 its own questions over `curl`, exactly as it does everywhere else.

 **The probes are deliberately shallow.** They ask whether something answers,
 whether it takes the key, and what models it has. They do not validate the
 format, count conformance levels or parse an envelope — all of which is the
 daemon's work and none of which belongs in Swift. The endpoints they call are
 the same two `Interchange.reachable` calls, and that is the coupling to watch:
 if the binding ever moves them, this goes stale and starts reporting a healthy
 producer as absent.
 */

// MARK: - The file

/// What the settings panel edits. A subset of the daemon's schema plus the four
/// keys only the app reads — deliberately not the whole file, which is why every
/// write is an overlay rather than a replacement.
struct TalariaConfig: Equatable, Sendable {
    var origin = ""
    var accessKey = ""
    var pollSeconds = 30
    var glanceUrl = "http://localhost:11434"
    var glanceModel = "nomic-embed-text:latest"
    /// Where Talaria's own chat thinks. Separate from Glance's on purpose —
    /// an embedding model and a tool-calling chat model are rarely the same
    /// one, and often not even the same machine.
    var inferenceUrl = "http://localhost:11434"
    var inferenceModel = ""
    var contextExclude: [String] = []
    var aerospaceCli = ""

    // Read by the app, ignored by the daemon: zod strips what it does not
    // declare rather than rejecting it, which is what lets these live here.
    var boardHotkey = ""
    var assistantHotkey = ""
    var glanceHotkey = ""
    var composeHotkey = ""
    var menuBarSymbol = ""
    /// Whether undated hits sit below Glance's fold rather than above it.
    /// Off by default — see `Daemon.GlanceHit.isAbove(theFold:)`.
    var glanceUndatedFurtherOut = false
    /// Similarity below which a hit is filed under "less similar" rather than
    /// shown in the main list. Zero switches it off, which is the default: a
    /// threshold is a judgement about one library's scores and there is no
    /// number that is right for everybody's.
    var glanceThreshold = 0.0
    /// Whether finished things get their own section instead of sitting among
    /// the live ones.
    var glanceSeparateDone = false

    /// Sent to the daemon only when set; an empty string is not a default, it is
    /// the absence of an answer. `riftCli: ""` would be taken as a path and
    /// looked for, which is worse than not being there.
    static let defaults = TalariaConfig()
}

enum ConfigStore {
    static let directory = NSHomeDirectory() + "/Library/Application Support/Talaria"
    static let path = directory + "/config.json"

    static var exists: Bool { FileManager.default.fileExists(atPath: path) }

    /// Whatever is on disk right now, unparsed.
    private static func rawObject() -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return obj
    }

    static func load() -> TalariaConfig {
        let obj = rawObject()
        var c = TalariaConfig()
        func str(_ key: String) -> String { (obj[key] as? String) ?? "" }
        c.origin = str("origin")
        c.accessKey = str("accessKey")
        c.pollSeconds = (obj["pollSeconds"] as? Int) ?? 30
        if !str("glanceUrl").isEmpty { c.glanceUrl = str("glanceUrl") }
        if !str("glanceModel").isEmpty { c.glanceModel = str("glanceModel") }
        if !str("inferenceUrl").isEmpty { c.inferenceUrl = str("inferenceUrl") }
        c.inferenceModel = str("inferenceModel")
        c.contextExclude = (obj["contextExclude"] as? [String]) ?? []
        c.aerospaceCli = str("aerospaceCli")
        c.boardHotkey = str("boardHotkey")
        c.assistantHotkey = str("assistantHotkey")
        c.glanceHotkey = str("glanceHotkey")
        c.composeHotkey = str("composeHotkey")
        c.menuBarSymbol = str("menuBarSymbol")
        c.glanceUndatedFurtherOut = (obj["glanceUndatedFurtherOut"] as? Bool) ?? false
        c.glanceThreshold = (obj["glanceThreshold"] as? Double) ?? 0
        c.glanceSeparateDone = (obj["glanceSeparateDone"] as? Bool) ?? false
        return c
    }

    /**
     Write the edited fields over whatever is already there.

     An overlay, never a replacement, and for the reason the format itself gives:
     unknown keys survive byte-identical. This panel does not know every field
     the daemon may grow, a newer daemon writing one it has never heard of is
     entirely ordinary, and a save that rebuilt the object from the form would
     silently delete it. Re-read at write time rather than held from load, so a
     change made in between is merged rather than clobbered.

     Atomic, then `chmod 600` — in that order, because an atomic write is a
     rename onto the path and the replacement arrives with the umask's mode
     rather than the mode the old file had. This file holds an access key.
     */
    static func save(_ c: TalariaConfig) throws {
        var obj = rawObject()
        obj["origin"] = c.origin
        obj["accessKey"] = c.accessKey
        obj["pollSeconds"] = c.pollSeconds
        obj["glanceUrl"] = c.glanceUrl
        obj["glanceModel"] = c.glanceModel
        obj["inferenceUrl"] = c.inferenceUrl
        obj["inferenceModel"] = c.inferenceModel

        // Present when set, absent when not. See `TalariaConfig.defaults`.
        func optional(_ key: String, _ value: String) {
            if value.trimmingCharacters(in: .whitespaces).isEmpty { obj.removeValue(forKey: key) }
            else { obj[key] = value.trimmingCharacters(in: .whitespaces) }
        }
        optional("aerospaceCli", c.aerospaceCli)
        optional("boardHotkey", c.boardHotkey)
        optional("assistantHotkey", c.assistantHotkey)
        optional("glanceHotkey", c.glanceHotkey)
        optional("composeHotkey", c.composeHotkey)
        optional("menuBarSymbol", c.menuBarSymbol)
        if c.contextExclude.isEmpty { obj.removeValue(forKey: "contextExclude") }
        else { obj["contextExclude"] = c.contextExclude }

        // A false is the default, so it is written only when true. Keeps a file
        // nobody has changed identical to the one the panel first wrote.
        if c.glanceUndatedFurtherOut { obj["glanceUndatedFurtherOut"] = true }
        else { obj.removeValue(forKey: "glanceUndatedFurtherOut") }
        if c.glanceSeparateDone { obj["glanceSeparateDone"] = true }
        else { obj.removeValue(forKey: "glanceSeparateDone") }
        if c.glanceThreshold > 0 { obj["glanceThreshold"] = c.glanceThreshold }
        else { obj.removeValue(forKey: "glanceThreshold") }

        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true
        )
        let data = try JSONSerialization.data(
            withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }

    /**
     The daemon's schema, checked here so the answer arrives in the panel.

     Duplicated from `config.ts` and worth the duplication: the alternative is a
     save that succeeds, a daemon that exits 78 on the next start, and a person
     looking at a settings window that told them everything was fine. The
     constraints are copied, not invented — keep them in step with the zod
     schema.
     */
    static func problems(_ c: TalariaConfig) -> [String] {
        var out: [String] = []
        if let u = URL(string: c.origin), let scheme = u.scheme?.lowercased(),
           scheme == "http" || scheme == "https", u.host?.isEmpty == false {
            // fine
        } else {
            out.append("The Hermes address needs to be a full URL, like https://example.com/hermesnotes")
        }
        if c.accessKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append("An access key is required — mint one in Hermes under Settings → Access keys.")
        }
        if c.pollSeconds < 2 || c.pollSeconds > 3600 {
            out.append("Sync interval has to be between 2 and 3600 seconds.")
        }
        if URL(string: c.glanceUrl)?.host == nil {
            out.append("The embedding address needs to be a full URL, like http://localhost:11434")
        }
        if c.glanceModel.trimmingCharacters(in: .whitespaces).isEmpty {
            out.append("Glance needs an embedding model.")
        }
        return out
    }
}

// MARK: - Asking whether things are there

/// What a probe found. Three outcomes rather than a boolean, because "nothing
/// answered" and "something answered and said no" send a person to entirely
/// different places.
enum Reach: Equatable, Sendable {
    case ok(String)
    case warn(String)
    case bad(String)

    var detail: String {
        switch self {
        case let .ok(s), let .warn(s), let .bad(s): return s
        }
    }
}

/// One model an embedding server has, and whether it is the kind that embeds.
struct EmbedModel: Identifiable, Hashable, Sendable {
    let name: String
    /// From `details.embedding_length`. Worth showing: a vector's meaning
    /// depends on the model that made it, and the width is the visible part of
    /// that.
    let dimensions: Int?
    /// Declared in `capabilities`. Absent on older servers, which is why the
    /// list degrades to showing everything rather than to showing nothing.
    let embeds: Bool
    var id: String { name }
}

enum Probe {
    /**
     Is this address on this machine?

     Mirrors `isLocal` in `glance.ts`, including its refusal to match by prefix
     — `http://localhost.evil.example/` is not localhost, and treating it as one
     would send the front window's text off the machine while the panel showed a
     reassuring green dot. The cases that pin this down live in
     `glancecheck.ts`; keep the two in step.
     */
    static func isLocal(_ url: String) -> Bool {
        url.range(
            of: #"^https?://(localhost|127\.0\.0\.1|\[::1\])(:|/|$)"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    /**
     One HTTP call, with the key kept out of `argv`.

     `curl -K -` reads its options from standard input, which is the whole
     reason it is used here: an `Authorization` header on the command line is
     visible to every process on the machine through `ps`, and this one carries
     a Hermes access key. Same argument as the capture path, same solution.
     */
    private static func fetch(url: String, bearer: String? = nil, timeout: Int = 8) -> (status: Int, body: String, failed: Bool) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        task.arguments = ["-s", "-L", "--max-time", "\(timeout)", "-w", "\n%{http_code}", "-K", "-"]
        let stdin = Pipe(), out = Pipe()
        task.standardInput = stdin
        task.standardOutput = out
        task.standardError = Pipe()

        // curl's config parser takes C-style escapes inside a quoted value.
        func quoted(_ s: String) -> String {
            "\"" + s.replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"") + "\""
        }
        var options = "url = \(quoted(url))\n"
        if let bearer, !bearer.isEmpty {
            options += "header = \(quoted("authorization: Bearer \(bearer)"))\n"
        }

        do { try task.run() } catch { return (0, "\(error)", true) }
        stdin.fileHandleForWriting.write(Data(options.utf8))
        stdin.fileHandleForWriting.closeFile()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()

        let text = String(data: data, encoding: .utf8) ?? ""
        // The status is the last line; everything before it is the body.
        guard let cut = text.lastIndex(of: "\n") else {
            return (0, text, true)
        }
        let status = Int(text[text.index(after: cut)...].trimmingCharacters(in: .whitespaces)) ?? 0
        let body = String(text[..<cut])
        return (status, body, task.terminationStatus != 0 || status == 0)
    }

    /**
     Is the producer there, and does it know this key?

     Two questions with different answers, so two calls — the same pair, in the
     same order, as `Interchange.reachable`. `conformance` is unauthenticated by
     design, which makes it the honest test of *reachable*: a 401 from it would
     say nothing about the network. Then one deliberately empty read, which is
     the cheapest thing that can be refused.
     */
    static func producer(origin: String, key: String) -> Reach {
        let base = origin.hasSuffix("/") ? String(origin.dropLast()) : origin
        // `/api/conformance`, not `/api/interchange/conformance`. The binding
        // mounts under `/api` and the manifest sits at its root, beside the
        // `/interchange` collection rather than inside it. Getting this wrong
        // does not fail loudly: the wrong path 404s, which reads as "this is
        // not a spec producer" — a confident, wrong diagnosis of a server that
        // is perfectly healthy.
        let conformance = fetch(url: "\(base)/api/conformance")
        if conformance.failed {
            return .bad("Nothing answered at that address.")
        }
        if conformance.status == 404 {
            return .warn("Something answered, but it does not serve the interchange format. Check the path — Hermes usually sits under a prefix like /hermesnotes.")
        }
        // A gateway error means the address is right and the thing behind it is
        // down — a tunnel or reverse proxy answering for a server that is not
        // there. Worth saying, because "530" sends nobody anywhere useful and
        // this is what a machine at the far end being switched off looks like.
        if conformance.status >= 500 {
            return .bad("The address is reachable but Hermes is not answering (HTTP \(conformance.status)). If it sits behind a proxy or tunnel, the proxy is up and the server behind it is not.")
        }
        guard (200..<300).contains(conformance.status) else {
            return .bad("The address answered \(conformance.status).")
        }

        // `__none__` matches no profile, so this is a valid read that returns an
        // empty library — the least expensive thing the key can be refused for.
        // This one *is* under `/interchange`; the two paths differ and the
        // difference is not guessable, which is why both are written down.
        let read = fetch(url: "\(base)/api/interchange?profile=__none__", bearer: key)
        if read.failed { return .bad("Reachable, but the read did not complete.") }
        if read.status == 401 || read.status == 403 {
            return .bad("Reachable, but the access key was refused. Mint a fresh one under Settings → Access keys.")
        }
        if read.status == 410 { return .ok("Reachable, key accepted.") }
        guard (200..<300).contains(read.status) else {
            return .bad("Reachable, but the read answered \(read.status).")
        }
        return .ok("Reachable, key accepted.")
    }

    /**
     What this embedding server has installed.

     Filtered to the models that declare they can embed, when any of them do. A
     chat model in this list is a trap: Ollama will answer an embed request for
     one, the numbers come back, and the ranking is quietly meaningless. When
     nothing declares a capability — an older server — the filter would empty
     the list instead, so it steps aside and shows everything.
     */
    static func models(at url: String) -> (models: [EmbedModel], reach: Reach) {
        let base = url.hasSuffix("/") ? String(url.dropLast()) : url
        let res = fetch(url: "\(base)/api/tags", timeout: 5)
        if res.failed {
            return ([], .bad("No embedding server answered. Is Ollama running?"))
        }
        guard (200..<300).contains(res.status) else {
            return ([], .bad("The address answered \(res.status) — is that an Ollama server?"))
        }
        guard let data = res.body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["models"] as? [[String: Any]]
        else {
            return ([], .bad("Something answered, but not with a model list."))
        }

        let all: [EmbedModel] = raw.compactMap { m in
            guard let name = m["name"] as? String else { return nil }
            let details = m["details"] as? [String: Any]
            let caps = (m["capabilities"] as? [String]) ?? []
            return EmbedModel(
                name: name,
                dimensions: details?["embedding_length"] as? Int,
                embeds: caps.contains("embedding")
            )
        }
        let embedders = all.filter(\.embeds)
        let shown = embedders.isEmpty ? all : embedders
        if shown.isEmpty {
            return ([], .warn("Answered, but has no models installed. Try: ollama pull nomic-embed-text"))
        }
        let where_ = isLocal(url) ? "on this machine" : "at \(URL(string: url)?.host ?? url)"
        return (shown.sorted { $0.name < $1.name },
                .ok("\(shown.count) model\(shown.count == 1 ? "" : "s") \(where_)."))
    }
}
