import Foundation
import WebKit

/**
 A web view that can talk to the daemon.

 `WKWebView` speaks http and nothing else, and the daemon listens on a Unix
 socket. That leaves two ways to put a page in front of somebody: give the
 daemon a TCP port, or carry the requests yourself. A port would make every
 process on the machine a client of a service that answers questions about what
 the user is reading, so this carries them.

 The page is written as though it were on an ordinary server — `fetch("/canvas/
 document")`, `<img src="/canvas/image/…">` — and this turns each of those into
 a request on the socket. Nothing in the page knows, which is the point: the
 same files work behind WebKitGTK's scheme handler on Linux with no changes.

 `curl` again, for the reason `Daemon.swift` already gives: Foundation has no
 Unix-socket transport, and framing HTTP by hand over a raw socket is a great
 deal of code to get subtly wrong.

 Three kinds of request arrive here, and only one of them travels:

 - Anything under `/ui/` is a file in the bundle. The pages are shared with the
   Linux shell, built once and read by both.
 - Anything under `/shell/` is a verb only a shell can perform — the writing
   surface's documents, for now. It never reaches the daemon, which is what
   lets that surface work with the daemon stopped and the network down.
 - Everything else is the daemon's.
 */
final class DaemonScheme: NSObject, WKURLSchemeHandler {
    /// The scheme the page is served under. Any host; the path is the daemon's.
    static let scheme = "talaria-app"
    static let origin = "\(scheme)://daemon"

    private let socketPath: String
    /**
     Tasks still wanted, held strongly.

     Messaging a stopped or abandoned `WKURLSchemeTask` is a crash rather than an
     error — a segfault inside `objc_release` while the autorelease pool drains,
     which names nothing and points at nobody.

     Two things went wrong with keeping only identifiers. `ObjectIdentifier` is
     an address and does not retain, so a task could be deallocated and a new one
     land on the same address, and a stopped task would read as live. And
     closing the window released the web view while requests were still in
     flight: WebKit does not promise a `stop` for those, so the completion came
     back on the main queue, found nothing to tell it otherwise, and messaged a
     task whose owner was gone.

     Holding the task fixes both — an object this dictionary owns cannot be
     deallocated underneath it, and `cancelAll` is what the window calls before
     letting go of the view.
     */
    private var live: [ObjectIdentifier: any WKURLSchemeTask] = [:]
    private let lock = NSLock()

    /// Forget every outstanding task. Called when the view they belong to is
    /// going away, so nothing that comes back later tries to speak to it.
    func cancelAll() {
        lock.lock()
        live.removeAll()
        lock.unlock()
    }

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    private func isLive(_ task: WKURLSchemeTask) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return live[ObjectIdentifier(task)] != nil
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        lock.lock(); live[ObjectIdentifier(task)] = task; lock.unlock()

        guard let url = task.request.url else {
            finish(task, error: URLError(.badURL))
            return
        }
        var path = url.path.isEmpty ? "/" : url.path
        if path == "/" { path = "/canvas/app/index.html" }
        if let q = url.query, !q.isEmpty { path += "?\(q)" }

        let method = task.request.httpMethod ?? "GET"
        // The body rides in a header.
        //
        // `WKWebView` strips the body from a custom-scheme request — it arrives
        // as nil however it was sent — and Qt's `requestBody()` segfaults
        // outright in the PySide6 build the Linux shell uses. So `api.js` puts
        // the payload in `x-talaria-body` and both shells read it from there.
        // One workaround, forced independently on two platforms, which is at
        // least a sign it is the right shape.
        let header = task.request.value(forHTTPHeaderField: "x-talaria-body")
        let body = header.map { Data($0.utf8) } ?? task.request.httpBody

        // Answered here, without leaving the process.
        if path.hasPrefix("/ui/") || path == "/" {
            deliver(task, file(at: path == "/" ? "/ui/index.html" : path))
            return
        }
        if path.hasPrefix("/shell/") {
            deliver(task, shellVerb(path: path, method: method, body: body))
            return
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result = self.ask(path: path, method: method, body: body)
            DispatchQueue.main.async {
                guard self.isLive(task) else { return }
                switch result {
                case let .success((data, mime, status)):
                    // Given explicitly rather than inferred: a response with no
                    // declared type is sniffed, and a JSON reply sniffed as text
                    // is a `fetch` that resolves to something unusable.
                    let response = HTTPURLResponse(
                        url: url,
                        statusCode: status,
                        httpVersion: "HTTP/1.1",
                        headerFields: ["Content-Type": mime, "Content-Length": String(data.count)]
                    )!
                    task.didReceive(response)
                    task.didReceive(data)
                    task.didFinish()
                case let .failure(error):
                    task.didFailWithError(error)
                }
                self.forget(task)
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        forget(task)
    }

    /// Hand back an answer worked out on this thread, and stop tracking it.
    private func deliver(_ task: WKURLSchemeTask, _ result: Result<(Data, String, Int), Error>) {
        guard isLive(task) else { return }
        switch result {
        case let .success((data, mime, status)):
            let response = HTTPURLResponse(
                url: task.request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": mime, "Content-Length": String(data.count)]
            )!
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        case let .failure(error):
            task.didFailWithError(error)
        }
        forget(task)
    }

    // MARK: Things only a shell can do

    private func json(_ value: Any, _ status: Int = 200) -> Result<(Data, String, Int), Error> {
        let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
        return .success((data, "application/json", status))
    }

    private func problem(_ sentence: String) -> Result<(Data, String, Int), Error> {
        json(["ok": false, "error": sentence])
    }

    private func shellVerb(path: String, method: String, body: Data?) -> Result<(Data, String, Int), Error> {
        let parts = path.dropFirst("/shell/".count).split(separator: "?", maxSplits: 1)
        let what = String(parts.first ?? "")
        let query = parts.count > 1 ? String(parts[1]) : ""
        switch what {
        case "writing": return writing(query: query, method: method, body: body)
        default: return problem("this shell has no verb called \(what)")
        }
    }

    /// `?name=x&do=y` as a dictionary, with each value un-escaped.
    private func params(_ query: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in query.split(separator: "&") {
            let halves = pair.split(separator: "=", maxSplits: 1)
            guard let key = halves.first else { continue }
            let raw = halves.count > 1 ? String(halves[1]) : ""
            out[String(key)] = raw.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? raw
        }
        return out
    }

    private func sent(_ body: Data?) -> [String: Any] {
        guard let body, let v = try? JSONSerialization.jsonObject(with: body) else { return [:] }
        return v as? [String: Any] ?? [:]
    }

    /**
     Where the writing surface keeps its documents.

     Beside the daemon's things, because that is where Talaria's state lives —
     and a plain directory of `.md` files rather than a database, because a
     writing application whose work can only be read by itself is a trap.
     */
    private static var writingDir: URL {
        let where_ = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/Talaria/writing", isDirectory: true)
        try? FileManager.default.createDirectory(at: where_, withIntermediateDirectories: true)
        return where_
    }

    /**
     A document name, or nothing.

     One path component, ending in `.md`. A name is a string that becomes a path,
     and the rule applies with more force here than when serving a file, because
     this one is *written* to: `../../.ssh/authorized_keys` is a perfectly good
     file name until somebody says otherwise.
     */
    private func writingName(_ raw: String) -> String? {
        var name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 120 else { return nil }
        if !name.hasSuffix(".md") { name += ".md" }
        guard (name as NSString).lastPathComponent == name, !name.hasPrefix(".") else { return nil }
        guard name.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\\0:*?\"<>|")) == nil else { return nil }
        return name
    }

    /**
     The writing surface's documents — files, and nothing else.

     **This verb is the whole reason that surface can promise what it promises.**
     It is a writing page with no connection to Hermes Notes: no blocks, no
     types, no interchange, and nothing here reaches the daemon. The text lives
     in Application Support as Markdown, readable by anything, and Talaria's only
     claim on it is that it put it there.
     */
    private func writing(query: String, method: String, body: Data?) -> Result<(Data, String, Int), Error> {
        let args = params(query)
        let dir = Self.writingDir
        let fm = FileManager.default

        if method == "GET", args["name"] == nil {
            var rows: [[String: Any]] = []
            for name in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasSuffix(".md") {
                let attrs = try? fm.attributesOfItem(atPath: dir.appendingPathComponent(name).path)
                rows.append([
                    "name": name,
                    "bytes": (attrs?[.size] as? Int) ?? 0,
                    "updated": ((attrs?[.modificationDate] as? Date)?.timeIntervalSince1970) ?? 0,
                ])
            }
            // Most recently written first: a writing surface is opened to carry
            // on with something, and the thing you were carrying on with is
            // almost always the last one you touched.
            rows.sort { (($0["updated"] as? Double) ?? 0) > (($1["updated"] as? Double) ?? 0) }
            return json(["data": rows])
        }

        guard let name = writingName(args["name"] ?? (sent(body)["name"] as? String) ?? "") else {
            return problem("that is not a usable name")
        }
        let target = dir.appendingPathComponent(name)

        switch method {
        case "GET":
            guard let text = try? String(contentsOf: target, encoding: .utf8) else {
                // Not an error. Asking for a document that is not there yet is
                // what "new" looks like from this side.
                return json(["data": ["name": name, "text": "", "new": true]])
            }
            return json(["data": ["name": name, "text": text]])

        case "PUT":
            let text = (sent(body)["text"] as? String) ?? ""
            do {
                // Written beside and moved into place, so an interrupted save
                // cannot leave half a document where a whole one was.
                let temp = target.appendingPathExtension("part")
                try Data(text.utf8).write(to: temp, options: .atomic)
                _ = try fm.replaceItemAt(target, withItemAt: temp)
            } catch {
                return problem(error.localizedDescription)
            }
            let updated = ((try? fm.attributesOfItem(atPath: target.path))?[.modificationDate] as? Date)?
                .timeIntervalSince1970 ?? 0
            return json(["ok": true, "name": name, "updated": updated])

        case "POST":
            switch args["do"] ?? "" {
            case "delete":
                try? fm.removeItem(at: target)
                return json(["ok": true])
            case "rename":
                guard let to = writingName((sent(body)["to"] as? String) ?? "") else {
                    return problem("that is not a usable name")
                }
                let dest = dir.appendingPathComponent(to)
                if fm.fileExists(atPath: dest.path) {
                    return problem("there is already a document called \(to)")
                }
                do { try fm.moveItem(at: target, to: dest) } catch { return problem(error.localizedDescription) }
                return json(["ok": true, "name": to])
            default:
                return problem("the writing store has no such verb")
            }

        default:
            return problem("the writing store has no such verb")
        }
    }

    // MARK: The pages

    /// Where the shared UI lives once the app is built. See `build.sh`.
    private static let uiRoot = Bundle.main.resourceURL?.appendingPathComponent("ui", isDirectory: true)

    /**
     A file from the bundle.

     The name is checked rather than trusted. These files are ours, but a page is
     a place where a string becomes a path, and `../../.ssh/id_rsa` is a file
     name until somebody says otherwise.

     Without the query: a page may be asked for with one — the export view opens
     the canvas as `index.html?export=1` — and a file whose name ends in
     `?export=1` does not exist, which arrives as a page that fails to load with
     nothing to say why.
     */
    private func file(at path: String) -> Result<(Data, String, Int), Error> {
        guard let root = Self.uiRoot else { return .success((Data("no ui in this build".utf8), "text/plain", 404)) }
        let rel = String(path.split(separator: "?", maxSplits: 1)[0].dropFirst("/ui/".count))
        let target = root.appendingPathComponent(rel).standardizedFileURL
        guard target.path.hasPrefix(root.standardizedFileURL.path + "/"),
              let data = try? Data(contentsOf: target)
        else {
            return .success((Data("no such file: \(rel)".utf8), "text/plain", 404))
        }
        let mime = [
            "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
            "css": "text/css; charset=utf-8", "json": "application/json",
            "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg",
            "woff2": "font/woff2", "map": "application/json",
        ][target.pathExtension.lowercased()] ?? "application/octet-stream"
        return .success((data, mime, 200))
    }

    private func forget(_ task: WKURLSchemeTask) {
        lock.lock(); live[ObjectIdentifier(task)] = nil; lock.unlock()
    }

    private func finish(_ task: WKURLSchemeTask, error: Error) {
        task.didFailWithError(error)
        forget(task)
    }

    /// One request on the socket. Headers to stderr, body to stdout, so a
    /// picture comes back as bytes rather than as something to be un-escaped.
    private func ask(path: String, method: String, body: Data?) -> Result<(Data, String, Int), Error> {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        var args = [
            "-s", "--unix-socket", socketPath,
            "-X", method,
            "-D", "/dev/stderr",
            "http://talaria" + path,
        ]
        if let body, !body.isEmpty {
            args.append(contentsOf: ["-H", "content-type: application/json", "--data-binary", "@-"])
        }
        task.arguments = args

        let out = Pipe()
        let head = Pipe()
        task.standardOutput = out
        task.standardError = head
        if body != nil { task.standardInput = Pipe() }

        do {
            try task.run()
        } catch {
            return .failure(error)
        }
        if let body, let stdin = task.standardInput as? Pipe {
            stdin.fileHandleForWriting.write(body)
            try? stdin.fileHandleForWriting.close()
        }
        // Read before waiting: a reply larger than the pipe buffer deadlocks a
        // process that is waited on first, and a canvas full of photographs is
        // exactly that reply.
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let headers = String(data: head.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        task.waitUntilExit()

        if task.terminationStatus != 0 && data.isEmpty {
            return .failure(NSError(
                domain: "Talaria", code: Int(task.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: "the daemon isn't answering on \(socketPath)"]
            ))
        }
        var mime = "application/octet-stream"
        var status = 200
        for line in headers.split(whereSeparator: \.isNewline) {
            if line.lowercased().hasPrefix("content-type:") {
                mime = line.dropFirst("content-type:".count).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("HTTP/") {
                let parts = line.split(separator: " ")
                if parts.count > 1, let code = Int(parts[1]) { status = code }
            }
        }
        return .success((data, mime, status))
    }
}

extension WKWebViewConfiguration {
    /// Wire a configuration up to the daemon, and hand back the page's address.
    @discardableResult
    func servedByDaemon(socketPath: String) -> URL {
        setURLSchemeHandler(DaemonScheme(socketPath: socketPath), forURLScheme: DaemonScheme.scheme)
        return URL(string: DaemonScheme.origin + "/canvas/app/index.html")!
    }
}
