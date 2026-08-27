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

guard let app = NSWorkspace.shared.frontmostApplication else {
    FileHandle.standardOutput.write("{}".data(using: .utf8)!)
    exit(0)
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
var result: [String: String] = [:]
if let bundle = app.bundleIdentifier { result["app"] = bundle }

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

let data = try JSONSerialization.data(withJSONObject: result)
FileHandle.standardOutput.write(data)
