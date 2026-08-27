import AppKit
import ApplicationServices
import Foundation

/**
 A one-shot read of whatever text is focused, and nothing else.

 Talaria has gone out of its way not to need the accessibility tree: the
 frontmost app comes from Launch Services, workspaces come from Rift, and that
 was deliberate — three applications competing for AX observers is a known
 source of beachballs and the design says so in as many words.

 This does not add a fourth observer. It is a process that starts, asks one
 question, prints an answer and exits. The beachball risk belongs to continuous
 observation; a single query on a keypress is the same class of thing as
 `lsappinfo`, which is why it is a separate binary the daemon spawns rather than
 anything living inside the app.

 It exists because a window title is often not the document. "Untitled" tells you
 nothing, and an untitled draft is exactly when you cannot find the note you are
 looking for yourself.

 Prints JSON on stdout: `{"text": "...", "title": "...", "app": "..."}`, or `{}`
 when there is nothing readable — no permission, no focused text, an app that
 exposes none. Never an error: having nothing to say is the ordinary case.

 Flags, none of which the daemon passes — it always wants the plain read of
 whatever is in front:

   --app <bundle-id>   read that application instead of the frontmost one, so a
                       question about what an app exposes can be asked without
                       taking the keyboard away from whoever is using the Mac
   --deep              ask a Chromium-family app to build its accessibility tree
                       (AXManualAccessibility) and walk the page, for the ones
                       that render their own text
   --dump              print the tree, with roles and depths, to stderr
   --attrs <desc>      print every attribute of the node with that description
   --depth <n>         how far down to go (default 16)

 The last three are how the Google Docs question got settled: its "Document
 content" node is an AXTextArea one pixel tall whose visible character range is
 two characters long. The document is on a canvas and is fed to screen readers
 through a live region a keystroke at a time, so there is no full text in the
 tree to find — which is worth knowing before anybody spends another afternoon
 looking for it.

 `title` is here because the two things the daemon could otherwise ask both get
 it wrong. `lsappinfo` answers with the application's *display name* — the
 leading quoted token of its record is the name field — so a Chrome window
 showing a letter to Milton reports "Google Chrome", and a fallback that
 embedded it went looking for that. Rift has real titles, but only for windows
 it manages, and returns null for plenty of them. The accessibility tree has it
 for everything, and this process is already the one asking.
 */

/// How much is worth reading. A draft can be a whole book, and the embedder
/// truncates anyway — reading megabytes to throw them away is work nobody asked
/// for, and holding somebody's manuscript in memory is a thing not to do
/// casually even for a moment.
let maxChars = 4000

func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &out) == .success ? out : nil
}

/// The focused element's text, by the three names applications use for it.
func textOf(_ element: AXUIElement) -> String? {
    // Selected text first: if somebody has highlighted something, that is a
    // stronger statement of what they mean than the whole document is.
    for name in [kAXSelectedTextAttribute, kAXValueAttribute, kAXTitleAttribute] {
        if let v = attr(element, name as String) as? String, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return String(v.prefix(maxChars))
        }
    }
    return nil
}

// Never prompt. A permission dialog raised by a background daemon, at a moment
// the person was doing something else, is how a tool teaches somebody to click
// "don't allow" — and the answer to being refused here is to fall back to the
// window title, which works.
guard AXIsProcessTrusted() else {
    FileHandle.standardOutput.write(#"{"denied":true}"#.data(using: .utf8)!)
    exit(0)
}

/**
 Whose windows to read: the frontmost application, or a named one.

 `--app <bundle-id>` exists for working this out at all. Every question about
 what an application exposes has to be asked while that application is in
 front, which means every answer races with whoever is using the machine — and
 a diagnostic you cannot run without taking the keyboard away from somebody is
 one that gets run badly. The accessibility API does not care about focus:
 `AXUIElementCreateApplication` takes a pid, and a backgrounded window still
 reports its own focused window.

 Not used by the daemon, which always wants whatever is in front.
 */
let wantedApp: NSRunningApplication? = {
    let args = Array(CommandLine.arguments.dropFirst())
    if let i = args.firstIndex(of: "--app"), i + 1 < args.count {
        return NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == args[i + 1] }
    }
    return NSWorkspace.shared.frontmostApplication
}()

guard let app = wantedApp else {
    FileHandle.standardOutput.write("{}".data(using: .utf8)!)
    exit(0)
}

/**
 Ask a Chromium-family application to build its accessibility tree.

 Chrome does not have one by default. It builds the web-content tree lazily,
 when it believes an assistive technology is listening — VoiceOver announces
 itself by setting `AXEnhancedUserInterface`, and everyone else is expected to
 set `AXManualAccessibility`. Until something does, the tree is a handful of
 anonymous `AXGroup` shells with no text in them at all, which is exactly what
 Chrome was handing us: a Google Doc whose title was readable and whose body
 did not exist as far as the accessibility API was concerned.

 The one thing you cannot do is set it and read immediately. The renderer
 builds the tree asynchronously, across processes, so the first look after
 asking finds nothing and the answer arrives a beat later.

 Electron's documentation is the clearest statement of the contract, and notes
 that the user's own assistive utilities take priority over this and will
 override it — which is the right precedence.
 */
func enableWebContent(_ axApp: AXUIElement) {
    AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
}

/// Roles that actually carry words. Everything else is scaffolding.
let textBearing: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField", "AXHeading"]

/// How deep to go. A web page is arbitrarily deep; Google Docs in particular
/// buries the document body far below the chrome around it.
var maxDepth = 16

/**
 Gather the text under an element, bounded in both directions.

 Depth-limited because a web page is arbitrarily deep and a runaway walk on the
 main thread of a hotkey is a beachball. Budget-limited because the embedder
 truncates at a few hundred characters anyway, so reading a whole inbox to throw
 it away is work nobody asked for.
 */
func collectText(_ element: AXUIElement, depth: Int, budget: inout Int, into out: inout [String]) {
    if depth > maxDepth || budget <= 0 { return }
    if let role = attr(element, kAXRoleAttribute as String) as? String, textBearing.contains(role) {
        if let v = attr(element, kAXValueAttribute as String) as? String {
            let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty {
                out.append(t)
                budget -= t.count
            }
        }
    }
    guard let kids = attr(element, kAXChildrenAttribute as String) as? [AXUIElement] else { return }
    for k in kids {
        if budget <= 0 { return }
        collectText(k, depth: depth + 1, budget: &budget, into: &out)
    }
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
var result: [String: String] = [:]
if let bundle = app.bundleIdentifier { result["app"] = bundle }

// `--deep`: turn on the browser's tree and read the page, for the applications
// that render their own text and expose nothing otherwise. Opt-in because it
// asks another application to do work it had chosen not to do.
let args = Array(CommandLine.arguments.dropFirst())
let deep = args.contains("--deep")
if let i = args.firstIndex(of: "--depth"), i + 1 < args.count, let d = Int(args[i + 1]) { maxDepth = d }
// `--dump` prints the tree with roles and depths, for working out where an
// application actually keeps its words. Diagnostic, never used by the daemon.
let dumping = args.contains("--dump")
if deep {
    enableWebContent(axApp)
}

// The window's own title, whether or not its contents will show themselves.
// Reported alongside rather than instead: a document beats a title when there
// is one, and that choice belongs to the caller.
if let raw = attr(axApp, kAXFocusedWindowAttribute as String) {
    let window = unsafeBitCast(raw, to: AXUIElement.self)
    if let title = (attr(window, kAXTitleAttribute as String) as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
        result["title"] = String(title.prefix(maxChars))
    }
}

if let focused = attr(axApp, kAXFocusedUIElementAttribute as String) {
    // The cast is unchecked because AXUIElement is a CFType that does not
    // bridge; this is the documented shape of the API.
    let element = unsafeBitCast(focused, to: AXUIElement.self)
    if let text = textOf(element) {
        result["text"] = text
    }
}

// Asked to look properly, so look — even when the focused element answered.
//
// Not gated on the focused read coming back empty, which is what it was and
// which made this dead code in the one case it exists for. `textOf` falls back
// to `AXTitle`, and a browser's focused element is often the web area, whose
// title is the page title: Chrome therefore "had text", the walk never ran, and
// the result was the tab name dressed up as document content.
if dumping, let raw = attr(axApp, kAXFocusedWindowAttribute as String) {
    func dump(_ e: AXUIElement, _ d: Int) {
        if d > maxDepth { return }
        let role = (attr(e, kAXRoleAttribute as String) as? String) ?? "?"
        let value = (attr(e, kAXValueAttribute as String) as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).prefix(70) ?? ""
        let desc = (attr(e, kAXDescriptionAttribute as String) as? String)?.prefix(40) ?? ""
        let kids = (attr(e, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
        if !value.isEmpty || !desc.isEmpty || kids.count > 1 {
            FileHandle.standardError.write(
                "\(String(repeating: " ", count: d))\(role) kids=\(kids.count) desc=\(desc) value=\(value)\n"
                    .data(using: .utf8)!)
        }
        for k in kids { dump(k, d + 1) }
    }
    usleep(1_200_000)
    dump(unsafeBitCast(raw, to: AXUIElement.self), 0)
}

// `--attrs`: find the node whose description names it, and print everything it
// will answer. The only reliable way to learn how an application keeps its text.
if let i = args.firstIndex(of: "--attrs"), i + 1 < args.count,
   let raw = attr(axApp, kAXFocusedWindowAttribute as String) {
    let wanted = args[i + 1]
    func hunt(_ e: AXUIElement, _ d: Int) {
        if d > maxDepth { return }
        let desc = (attr(e, kAXDescriptionAttribute as String) as? String) ?? ""
        if desc == wanted {
            var names: CFArray?
            AXUIElementCopyAttributeNames(e, &names)
            let list = (names as? [String]) ?? []
            FileHandle.standardError.write("MATCH \(desc) — \(list.count) attributes\n".data(using: .utf8)!)
            for n in list {
                let v = attr(e, n)
                var shown = "\(v ?? "nil" as CFTypeRef)".replacingOccurrences(of: "\n", with: "\\n")
                if shown.count > 160 { shown = String(shown.prefix(160)) + "…" }
                FileHandle.standardError.write("   \(n) = \(shown)\n".data(using: .utf8)!)
            }
        }
        for k in (attr(e, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] { hunt(k, d + 1) }
    }
    usleep(1_200_000)
    hunt(unsafeBitCast(raw, to: AXUIElement.self), 0)
}

if deep {
    var found: [String] = []
    for _ in 0..<20 {
        usleep(100_000)
        guard let raw = attr(axApp, kAXFocusedWindowAttribute as String) else { continue }
        var budget = maxChars
        found = []
        collectText(unsafeBitCast(raw, to: AXUIElement.self), depth: 0, budget: &budget, into: &found)
        if !found.isEmpty { break }
    }
    // The better of the two, by length. A page walk that found less than the
    // focused element did has told us nothing new — an empty tab, or a tree
    // that never finished building — and the focused read is the safer answer.
    let page = found.joined(separator: "\n")
    if page.count > (result["text"]?.count ?? 0) {
        result["text"] = String(page.prefix(maxChars))
        result["via"] = "page"
    }
}

let data = try JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(data)
