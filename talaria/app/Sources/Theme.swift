import AppKit
import SwiftUI

/// Hermes' own palette and shapes.
///
/// Taken from `apps/web/src/styles.css` rather than invented, so the two
/// surfaces are recognizably the same application. The names match the CSS
/// custom properties they came from, which is what will make it obvious what to
/// change if the web app's palette ever moves.
enum Theme {
    static let accent = Color(hex: "5fa4b5")!      // --accent, the logo teal
    static let accentInk = Color(hex: "3d4247")!   // --accent-ink, the logo slate
    static let danger = Color(hex: "b5525f")!      // --danger
    /// The color of a line that is only there while something is being
    /// dragged. Deliberately not the accent: an accent-colored guide over an
    /// accent-colored selection is two different meanings in one color.
    static let snapGuide = Color(hex: "e0555f")!
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

    /**
     A block type's icon, from the key the type itself declares.

     Never from its name. A type is a row somebody owns and renames, and the
     composer was picking its icon by looking for "task" or "person" inside the
     word — so `Organization` and `Text` matched nothing and were drawn with the
     wrench that means "no idea", while a type renamed to `Errand` would have
     lost its tick. That is the same guess this project has written down twice
     as a bug, made a third time in a menu.

     Hermes names icons the way Lucide does and carries the key as
     `hermes:icon_key`; the daemon hands it over as `icon`. Only the ones that
     actually turn up are listed. A key with no obvious counterpart gets a
     neutral shape rather than a clever near-miss: an icon that is *almost*
     right is read as information, and a plain one is read as none.
     */
    static func symbol(forIconKey key: String?) -> String {
        switch (key ?? "").lowercased() {
        case "check-square", "checksquare", "circle-check-big", "circle-check", "square-check",
             "list-checks", "check": return "checkmark.square"
        case "calendar", "calendar-days", "calendar-clock", "calendar-check": return "calendar"
        case "user", "person", "contact", "users": return "person"
        case "building", "building2", "briefcase", "landmark": return "building.2"
        case "clipboard", "clipboard-list", "clipboard-check": return "clipboard"
        case "type", "text", "file-text", "filetext", "align-left": return "textformat"
        case "folder", "folder-open": return "folder"
        case "star", "sparkle", "sparkles": return "star"
        case "tag", "tags", "hash": return "tag"
        case "book", "book-open", "library", "notebook": return "book"
        case "list", "list-ordered": return "list.bullet"
        case "table", "table2", "grid", "layout-grid": return "tablecells"
        case "kanban", "columns": return "rectangle.split.3x1"
        case "map", "map-pin", "pin": return "mappin"
        case "mail", "inbox", "send": return "envelope"
        case "link", "link2", "paperclip": return "link"
        case "image", "camera": return "photo"
        case "quote", "message-square", "messages-square": return "quote.bubble"
        case "flag", "target", "goal": return "flag"
        case "lightbulb", "brain", "zap": return "lightbulb"
        case "heart": return "heart"
        case "clock", "timer", "history": return "clock"
        case "scroll", "scroll-text", "file", "files": return "doc.text"
        case "workflow", "git-branch", "share2": return "point.topleft.down.curvedto.point.bottomright.up"
        default: return "cube"
        }
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

    /// Whether a tool is one worth pausing over. Used to color a confirmation,
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
/// Anything belonging to this Hermes opens in Talaria's own window; anything
/// else is somebody else's website and goes to the browser. That distinction is
/// the whole reason the window exists — a deep link should land on the thing it
/// names, in the application that already knows what the link means.
enum Opener {
    /// Announced whenever something is opened, so the panel that offered the
    /// link can close itself without every call site remembering to.
    static let didOpen = Notification.Name("talaria.didOpen")

    /// Called from views, which are already on the main actor.
    @MainActor
    static func open(_ url: URL) {
        if HermesWindow.shared.isHermes(url) {
            HermesWindow.shared.show(url)
        } else {
            NSWorkspace.shared.open(url)
        }
        NotificationCenter.default.post(name: didOpen, object: nil)
    }
}

extension Color {
    /// Region colors arrive as hex, and Hermes writes eight digits — the last
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

/**
 Frosted glass behind a surface.

 The desk has always described its panes as frosted and never actually blurred
 anything: the panel is transparent and each pane filled itself with 35% white,
 which is a *veil*. It hides a busy desktop about as well as tracing paper —
 everything behind it is still legible, just paler — and text over it reads
 against whatever happens to be underneath.

 `NSVisualEffectView` blurring what is behind the window is the real thing, and
 on this platform it is one view. The Linux shell needed a Wayland protocol and
 a small C++ binding to ask its compositor for the same effect, after six routes
 from Python turned out to be closed; that file is worth reading for how much
 this costs elsewhere.

 `.active` regardless of focus, deliberately. A visual effect view dims itself
 when its window is not frontmost, which is right for a sidebar and wrong for
 something covering the whole screen: the desk would go flat the moment you
 clicked through to whatever it was over, which reads as it having closed.
 */
struct Frosting: NSViewRepresentable {
    /**
     `.fullScreenUI` because that is what this is.

     The materials are named for the situations they were tuned in, and the desk
     is a full-screen surface over whatever somebody was doing — which is the
     one this is for. `.hudWindow` is heavier and reads as a floating panel;
     `.sidebar` and `.popover` are tuned for something the size of a column.
     One word to change if it looks wrong on the day.
     */
    var material: NSVisualEffectView.Material = .fullScreenUI

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        // Behind the window, not within it. `.withinWindow` blurs this app's own
        // views, which for a transparent panel is blurring nothing at all.
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
    }
}
