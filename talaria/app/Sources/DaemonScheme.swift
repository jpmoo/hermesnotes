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
 */
final class DaemonScheme: NSObject, WKURLSchemeHandler {
    /// The scheme the page is served under. Any host; the path is the daemon's.
    static let scheme = "talaria-app"
    static let origin = "\(scheme)://daemon"

    private let socketPath: String
    /// Tasks still wanted. Messaging a stopped `WKURLSchemeTask` is a crash, not
    /// an error, and a slow request outliving the view it was for is ordinary.
    private var live = Set<ObjectIdentifier>()
    private let lock = NSLock()

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    private func isLive(_ task: WKURLSchemeTask) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return live.contains(ObjectIdentifier(task))
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        lock.lock(); live.insert(ObjectIdentifier(task)); lock.unlock()

        guard let url = task.request.url else {
            finish(task, error: URLError(.badURL))
            return
        }
        var path = url.path.isEmpty ? "/" : url.path
        if path == "/" { path = "/canvas/app/index.html" }
        if let q = url.query, !q.isEmpty { path += "?\(q)" }

        let method = task.request.httpMethod ?? "GET"
        let body = task.request.httpBody

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

    private func forget(_ task: WKURLSchemeTask) {
        lock.lock(); live.remove(ObjectIdentifier(task)); lock.unlock()
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
