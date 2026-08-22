import AppKit
import SwiftUI

/// Hermes' own palette and shapes.
///
/// Taken from `apps/web/src/styles.css` rather than invented, so the two
/// surfaces are recognisably the same application. The names match the CSS
/// custom properties they came from, which is what will make it obvious what to
/// change if the web app's palette ever moves.
enum Theme {
    static let accent = Color(hex: "5fa4b5")!      // --accent, the logo teal
    static let accentInk = Color(hex: "3d4247")!   // --accent-ink, the logo slate
    static let danger = Color(hex: "b5525f")!      // --danger
    static let postit = Color(hex: "fdf3b6")!      // --postit

    /// Radii: --radius-card and --radius-control.
    static let cardRadius: CGFloat = 12
    static let controlRadius: CGFloat = 9

    /// The web app sets Verdana for body and Tahoma for chrome. Both are on
    /// every Mac, so the family carries across rather than being approximated.
    static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom("Verdana", size: size).weight(weight)
    }
    static func chrome(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom("Tahoma", size: size).weight(weight)
    }

    /// A tool's icon, by what the tool does rather than by an exhaustive list —
    /// the MCP toolkit grows, and a lookup table would quietly fall behind and
    /// show a wrench for everything new.
    static func symbol(forTool tool: String) -> String {
        let t = tool.lowercased()
        switch true {
        case t.contains("search"), t.contains("find"), t.contains("query"): return "magnifyingglass"
        case t.contains("task"): return "checkmark.square"
        case t.contains("project"): return "clipboard"
        case t.contains("note"), t.contains("daily"): return "doc.text"
        case t.contains("calendar"), t.contains("event"): return "calendar"
        case t.contains("canvas"): return "square.grid.2x2"
        case t.contains("collection"), t.contains("list"), t.contains("matrix"): return "list.bullet.rectangle"
        case t.contains("tag"): return "tag"
        case t.contains("person"), t.contains("contact"): return "person"
        case t.contains("archive"), t.contains("delete"), t.contains("remove"): return "archivebox"
        case t.contains("create"), t.contains("add"): return "plus.circle"
        case t.contains("update"), t.contains("edit"): return "pencil"
        case t.contains("block"), t.contains("get"): return "cube"
        default: return "wrench.and.screwdriver"
        }
    }

    /// A collection's icon, by its kind. The web app gives each shape its own
    /// look; a picker row can at least say which shape it is.
    static func symbol(forCollection kind: String?) -> String {
        switch kind {
        case "matrix": return "square.grid.2x2"
        case "kanban": return "rectangle.split.3x1"
        case "table": return "tablecells"
        case "list": return "list.bullet"
        case "masonry": return "rectangle.grid.2x2"
        case "canvas": return "scribble.variable"
        case "calendar": return "calendar"
        case "rollup": return "list.bullet.indent"
        case "document": return "doc.text"
        default: return "square.stack"
        }
    }

    /// Whether a tool is one worth pausing over. Used to colour a confirmation,
    /// not to decide anything — Hermes has already decided by returning it as
    /// pending, and second-guessing that here would be a second opinion nobody
    /// asked for.
    static func isWeighty(_ tool: String) -> Bool {
        let t = tool.lowercased()
        return t.contains("delete") || t.contains("archive") || t.contains("remove")
    }
}

/// Opening a Hermes address.
///
/// Everything in Talaria resolves to an `https://` URL and hands it to whatever
/// opens those — normally a browser. `openWith` in config.json names an
/// application to hand them to instead, so a wrapped copy of Hermes can take
/// them rather than a browser tab.
enum Opener {
    private static var preferred: URL? {
        let path = NSHomeDirectory() + "/Library/Application Support/Talaria/config.json"
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = obj["openWith"] as? String, !name.isEmpty
        else { return nil }
        if name.hasPrefix("/") { return URL(fileURLWithPath: name) }
        // A bundle id, or a bare application name.
        if let byId = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return byId }
        return URL(fileURLWithPath: "/Applications/\(name).app")
    }

    static func open(_ url: URL) {
        guard let app = preferred, FileManager.default.fileExists(atPath: app.path) else {
            NSWorkspace.shared.open(url)
            return
        }
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, err in
            if let err {
                NSLog("talaria: couldn't open in \(app.lastPathComponent) — \(err); falling back")
                DispatchQueue.main.async { NSWorkspace.shared.open(url) }
            }
        }
    }
}

extension Color {
    /// Region colours arrive as hex, and Hermes writes eight digits — the last
    /// two being alpha, which a six-digit parser silently reads as blue.
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")).lowercased()
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        var alpha = 1.0
        if s.count == 8 {
            alpha = Double(Int(s.suffix(2), radix: 16) ?? 255) / 255
            s = String(s.prefix(6))
        }
        guard s.count == 6, let v = Int(s, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((v >> 16) & 0xff) / 255,
            green: Double((v >> 8) & 0xff) / 255,
            blue: Double(v & 0xff) / 255,
            opacity: alpha
        )
    }
}

/// Markdown, as much of it as a reply actually uses.
///
/// `AttributedString(markdown:)` handles the inline run — bold, italic, code,
/// links — but flattens block structure, so a reply that is mostly a list comes
/// out as one long paragraph. Lines are therefore split first and their leaders
/// read off, which covers what the assistant actually writes: paragraphs,
/// bullets, numbered steps, headings and fenced code.
struct MarkdownText: View {
    let text: String

    private enum Line: Identifiable {
        case heading(String, Int)
        case bullet(String)
        case numbered(String, String)
        case code(String)
        case paragraph(String)
        var id: String { UUID().uuidString }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(parse(), id: \.id) { line in
                switch line {
                case let .heading(s, level):
                    inline(s).font(Theme.body(level <= 1 ? 15 : 13, weight: .semibold))
                case let .bullet(s):
                    HStack(alignment: .top, spacing: 6) {
                        Text("•").font(Theme.body(12)).foregroundStyle(Theme.accent)
                        inline(s)
                    }
                case let .numbered(n, s):
                    HStack(alignment: .top, spacing: 6) {
                        Text(n).font(Theme.body(12)).foregroundStyle(Theme.accent).monospacedDigit()
                        inline(s)
                    }
                case let .code(s):
                    Text(s)
                        .font(.system(size: 11.5, design: .monospaced))
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 7).fill(.quaternary.opacity(0.45)))
                case let .paragraph(s):
                    inline(s)
                }
            }
        }
    }

    private func inline(_ s: String) -> Text {
        // .full so a line's own inline markup is honoured; failure falls back to
        // the raw text, which is always better than showing nothing.
        if let a = try? AttributedString(
            markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return Text(a).font(Theme.body(12))
        }
        return Text(s).font(Theme.body(12))
    }

    private func parse() -> [Line] {
        var out: [Line] = []
        var fence: [String]? = nil
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if let f = fence {
                    out.append(.code(f.joined(separator: "\n")))
                    fence = nil
                } else {
                    fence = []
                }
                continue
            }
            if fence != nil { fence?.append(line); continue }

            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { continue }
            if t.hasPrefix("#") {
                let level = t.prefix(while: { $0 == "#" }).count
                out.append(.heading(String(t.dropFirst(level)).trimmingCharacters(in: .whitespaces), level))
            } else if t.hasPrefix("- ") || t.hasPrefix("* ") {
                out.append(.bullet(String(t.dropFirst(2))))
            } else if let dot = t.firstIndex(of: "."), t[t.startIndex..<dot].allSatisfy(\.isNumber), dot < t.endIndex {
                let n = String(t[t.startIndex...dot])
                out.append(.numbered(n, String(t[t.index(after: dot)...]).trimmingCharacters(in: .whitespaces)))
            } else {
                out.append(.paragraph(t))
            }
        }
        if let f = fence, !f.isEmpty { out.append(.code(f.joined(separator: "\n"))) }
        return out
    }
}
