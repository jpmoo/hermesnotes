import AppKit
import SwiftUI

// MARK: - The vocabulary

/// Where the words sit across the box.
enum TextAlign: String, Codable, CaseIterable, Identifiable {
    case leading, center, trailing
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .leading: return "text.alignleft"
        case .center: return "text.aligncenter"
        case .trailing: return "text.alignright"
        }
    }
    var swiftUI: TextAlignment {
        switch self {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
    var appKit: NSTextAlignment {
        switch self {
        case .leading: return .left
        case .center: return .center
        case .trailing: return .right
        }
    }
    var frame: Alignment {
        switch self {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

/// And where they sit down it.
enum TextVAlign: String, Codable, CaseIterable, Identifiable {
    case top, middle, bottom
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .top: return "arrow.up.to.line"
        case .middle: return "arrow.up.and.down"
        case .bottom: return "arrow.down.to.line"
        }
    }
}

/// How a line is drawn. Three, because those are the three anybody draws.
enum LineStyle: String, Codable, CaseIterable, Identifiable {
    case solid, dashed, double
    var id: String { rawValue }
    var name: String { rawValue.capitalized }

    /// The dash pattern, scaled to the weight so a dashed hairline and a dashed
    /// thick line look like the same idea rather than two different ones.
    func dash(_ width: CGFloat) -> [CGFloat] {
        self == .dashed ? [max(width * 2.5, 3), max(width * 2, 2.5)] : []
    }
}

/// Together: where two boxes meet on an axis, as a fraction from top to bottom.
extension TextVAlign {
    var unit: CGFloat {
        switch self {
        case .top: return 0
        case .middle: return 0.5
        case .bottom: return 1
        }
    }

    var alignment: Alignment {
        switch self {
        case .top: return .top
        case .middle: return .center
        case .bottom: return .bottom
        }
    }
}

/// Both axes as one SwiftUI alignment, since a frame wants one value.
func combined(_ h: TextAlign, _ v: TextVAlign) -> Alignment {
    switch (h, v) {
    case (.leading, .top): return .topLeading
    case (.center, .top): return .top
    case (.trailing, .top): return .topTrailing
    case (.leading, .middle): return .leading
    case (.center, .middle): return .center
    case (.trailing, .middle): return .trailing
    case (.leading, .bottom): return .bottomLeading
    case (.center, .bottom): return .bottom
    case (.trailing, .bottom): return .bottomTrailing
    }
}

// MARK: - Colors, as text

/**
 A color, stored as a hex string.

 Not as archived `NSColor` data, and not as three floats. The canvas file is
 something a person opens and reads — that is the whole argument for it being
 JSON on disk rather than a defaults key — and `"#5fa4b5"` is readable where a
 base64 blob is not. It is also the spelling every other tool uses, including
 the one this canvas will eventually be written through, so nothing has to be
 translated later.

 Nil means "whatever the theme says", which is not the same as black. This canvas
 is drawn over a frost that follows the system appearance, and a color stored
 the first time somebody opened the inspector would be a label that disappears
 the next time they switch to dark.
 */
enum Hex {
    static func string(from color: Color) -> String? {
        guard let srgb = NSColor(color).usingColorSpace(.sRGB) else { return nil }
        let r = Int((srgb.redComponent * 255).rounded())
        let g = Int((srgb.greenComponent * 255).rounded())
        let b = Int((srgb.blueComponent * 255).rounded())
        let a = srgb.alphaComponent
        // Alpha only when it is doing something. Most colors are opaque and an
        // eight-digit hex for every one of them is noise in a file people read.
        if a >= 0.999 { return String(format: "#%02x%02x%02x", r, g, b) }
        return String(format: "#%02x%02x%02x%02x", r, g, b, Int((a * 255).rounded()))
    }

    static func color(_ hex: String?) -> Color? {
        guard let hex else { return nil }
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6 || s.count == 8, let n = UInt64(s, radix: 16) else { return nil }
        let hasAlpha = s.count == 8
        let r = Double((n >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let g = Double((n >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let b = Double((n >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let a = hasAlpha ? Double(n & 0xff) / 255 : 1
        return Color(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}

// MARK: - The inspector

/// One labeled row, so every control in here lines up with every other.
private struct Row<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content
    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(Theme.chrome(11))
                .foregroundStyle(.secondary)
                .frame(width: 76, alignment: .trailing)
            content
            Spacer(minLength: 0)
        }
    }
}

/// A row of choices, one of which is picked. The label is whatever the thing
/// being chosen is best shown as — usually a symbol, and for a line style the
/// line itself.
private struct Segmented<T: Hashable & Identifiable, Label: View>: View {
    let options: [T]
    @Binding var chosen: T
    @ViewBuilder let label: (T) -> Label

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                Button { chosen = option } label: {
                    label(option)
                        .font(.system(size: 11, weight: .medium))
                        .frame(width: 26, height: 20)
                        .contentShape(Rectangle())
                        .foregroundStyle(chosen == option ? Theme.accent : Color.secondary)
                        .background(
                            RoundedRectangle(cornerRadius: 5)
                                .fill(chosen == option ? Color.primary.opacity(0.10) : .clear)
                        )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private extension Segmented where Label == Image {
    /// The common case: a row of SF Symbols.
    ///
    /// The label is a bare `Image` and the font is applied in the body below.
    /// It was written the other way round for a moment — `Image(...).font(...)`
    /// forced to `Label` — which compiles and traps, because a modified image is
    /// not an `Image`.
    init(options: [T], symbol: @escaping (T) -> String, chosen: Binding<T>) {
        self.init(options: options, chosen: chosen) { Image(systemName: symbol($0)) }
    }
}

/**
 A line style, drawn as that line.

 It was three SF Symbols, and the one for dashed was `line.3.horizontal.decrease`
 — the filter glyph. Three horizontal bars of decreasing length, which does not
 look dashed and, worse, is nearly the same picture as the center-align icon two
 rows above it in the same panel. A control that sets how a line is drawn should
 show the line.
 */
private struct LineStyleGlyph: View {
    let style: LineStyle

    var body: some View {
        Canvas { context, size in
            let y = size.height / 2
            let inset: CGFloat = 3
            func line(_ offset: CGFloat, dash: [CGFloat]) {
                var path = Path()
                path.move(to: CGPoint(x: inset, y: y + offset))
                path.addLine(to: CGPoint(x: size.width - inset, y: y + offset))
                context.stroke(path, with: .color(.primary), style: StrokeStyle(lineWidth: 1.6, dash: dash))
            }
            switch style {
            case .solid: line(0, dash: [])
            case .dashed: line(0, dash: [3.5, 2.5])
            case .double: line(-2, dash: []); line(2, dash: [])
            }
        }
        .frame(width: 20, height: 12)
    }
}

/**
 A color well with a way back to nothing.

 `ColorPicker` is the system control, which means the system panel, which means
 the eyedropper and the palettes and everything else a person already knows. What
 it has no idea about is "unset" — it always holds a color — so the row carries
 its own way to say "no color", because that is a different answer from the
 color that happens to be showing.
 */
private struct ColorWell: View {
    let label: String
    @Binding var hex: String?
    /// What it looks like when nothing has been chosen.
    let placeholder: Color

    var body: some View {
        HStack(spacing: 6) {
            ColorPicker(
                "",
                selection: Binding(
                    get: { Hex.color(hex) ?? placeholder },
                    set: { hex = Hex.string(from: $0) }
                ),
                supportsOpacity: true
            )
            .labelsHidden()
            .frame(width: 44)

            Button("Default") { hex = nil }
                .font(Theme.chrome(10))
                .buttonStyle(.plain)
                .foregroundStyle(hex == nil ? Color.secondary.opacity(0.4) : Theme.accent)
                .disabled(hex == nil)
        }
    }
}

/**
 Everything about how one thing on the canvas looks.

 One panel for both an item and a connector, because most of the questions are
 the same question and two panels would be two places to change the answer. What
 differs is what is *offered*: a connector has no text and no fill, and a bare
 label has no outline — asking about a border on something that has none is a
 control that does nothing, which is worse than a control that is not there.
 */
struct CanvasInspector: View {
    @ObservedObject var model: CanvasModel
    /// Exactly one of these.
    var item: CanvasItem?
    var link: CanvasLink?
    var region: CanvasRegion?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if let item { itemControls(item) }
            if let link { linkControls(link) }
            if let region { regionControls(region) }
        }
        .padding(12)
        .frame(width: 268)
    }

    // MARK: An item

    @ViewBuilder
    private func itemControls(_ item: CanvasItem) -> some View {
        Row(label: "Shape") {
            Segmented(
                options: CanvasShape.allCases,
                symbol: { $0.symbol },
                chosen: Binding(
                    get: { model.item(item.id)?.shape ?? item.shape },
                    set: { model.setShape(item.id, $0) }
                )
            )
        }

        // A picture has no words in it, so none of this applies to one.
        if item.image == nil {
            Divider().opacity(0.4)
            Row(label: "Align") {
                Segmented(
                    options: TextAlign.allCases,
                    symbol: { $0.symbol },
                    chosen: binding(item, \.hAlign) { $0.hAlign = $1 }
                )
            }
            Row(label: "Vertical") {
                Segmented(
                    options: TextVAlign.allCases,
                    symbol: { $0.symbol },
                    chosen: binding(item, \.vAlign) { $0.vAlign = $1 }
                )
            }
            Row(label: "Text") {
                ColorWell(
                    label: "Text",
                    hex: binding(item, \.textColor) { $0.textColor = $1 },
                    placeholder: .primary
                )
            }
        }

        // Fill and outline belong to a shape. A bare label has neither, and a
        // picture is its own fill.
        if item.shape != .plain, item.image == nil {
            Divider().opacity(0.4)
            Row(label: "Background") {
                ColorWell(
                    label: "Background",
                    hex: binding(item, \.fill) { $0.fill = $1 },
                    placeholder: Color(nsColor: .windowBackgroundColor)
                )
            }
            Row(label: "Border") {
                ColorWell(
                    label: "Border",
                    hex: binding(item, \.stroke) { $0.stroke = $1 },
                    placeholder: .primary.opacity(0.7)
                )
            }
            weightAndStyle(
                width: binding(item, \.strokeWidth) { $0.strokeWidth = $1 },
                style: binding(item, \.strokeStyle) { $0.strokeStyle = $1 }
            )
        }
    }

    // MARK: A connector

    @ViewBuilder
    private func linkControls(_ link: CanvasLink) -> some View {
        Row(label: "Line") {
            ColorWell(
                label: "Line",
                hex: Binding(
                    get: { link.color },
                    set: { v in model.restyleLink(link.id) { $0.color = v } }
                ),
                placeholder: .primary.opacity(0.55)
            )
        }
        weightAndStyle(
            width: Binding(
                get: { link.width },
                set: { v in model.restyleLink(link.id) { $0.width = v } }
            ),
            style: Binding(
                get: { link.style },
                set: { v in model.restyleLink(link.id) { $0.style = v } }
            )
        )
    }

    // MARK: A region

    /**
     A region has a name and a box, and nothing else to say.

     No shape — it is the extent of what it holds and that is not a choice — and
     no size, for the same reason. What is left is the same questions as an item:
     what it is called, where the name sits, and how the box is drawn.
     */
    @ViewBuilder
    private func regionControls(_ region: CanvasRegion) -> some View {
        Row(label: "Name") {
            TextField("", text: Binding(
                get: { region.title },
                set: { v in model.restyleRegion(region.id) { $0.title = v } }
            ))
            .textFieldStyle(.roundedBorder)
            .font(Theme.chrome(11))
            .frame(width: 150)
        }
        Row(label: "Align") {
            Segmented(options: TextAlign.allCases, symbol: { $0.symbol }, chosen: Binding(
                get: { region.hAlign },
                set: { v in model.restyleRegion(region.id) { $0.hAlign = v } }
            ))
        }
        Row(label: "Text") {
            ColorWell(label: "Text", hex: Binding(
                get: { region.textColor },
                set: { v in model.restyleRegion(region.id) { $0.textColor = v } }
            ), placeholder: .secondary)
        }
        Divider().opacity(0.4)
        Row(label: "Background") {
            ColorWell(label: "Background", hex: Binding(
                get: { region.fill },
                set: { v in model.restyleRegion(region.id) { $0.fill = v } }
            ), placeholder: Theme.accent.opacity(0.08))
        }
        Row(label: "Border") {
            ColorWell(label: "Border", hex: Binding(
                get: { region.stroke },
                set: { v in model.restyleRegion(region.id) { $0.stroke = v } }
            ), placeholder: .primary.opacity(0.35))
        }
        weightAndStyle(
            width: Binding(
                get: { region.strokeWidth },
                set: { v in model.restyleRegion(region.id) { $0.strokeWidth = v } }
            ),
            style: Binding(
                get: { region.strokeStyle },
                set: { v in model.restyleRegion(region.id) { $0.strokeStyle = v } }
            )
        )
    }

    // MARK: Shared

    @ViewBuilder
    private func weightAndStyle(width: Binding<CGFloat>, style: Binding<LineStyle>) -> some View {
        Row(label: "Weight") {
            HStack(spacing: 7) {
                Slider(value: width, in: 0...8, step: 0.5).frame(width: 118)
                // Zero is a real answer and has to be reachable and readable.
                // "0" means no line at all, which is the only way to have a
                // shape that is only its fill.
                Text(width.wrappedValue == 0 ? "none" : String(format: "%.1f", width.wrappedValue))
                    .font(Theme.chrome(10)).monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 34, alignment: .leading)
            }
        }
        Row(label: "Style") {
            Segmented(options: LineStyle.allCases, chosen: style) { LineStyleGlyph(style: $0) }
        }
    }

    /// A binding onto one field of one item, written back through the model so
    /// the change is saved and undoable by the same path as everything else.
    private func binding<V>(
        _ item: CanvasItem,
        _ path: KeyPath<CanvasItem, V>,
        _ set: @escaping (inout CanvasItem, V) -> Void
    ) -> Binding<V> {
        Binding(
            get: { (model.item(item.id) ?? item)[keyPath: path] },
            set: { v in model.restyle(item.id) { set(&$0, v) } }
        )
    }
}

/**
 Search Hermes Notes, and hand back what was chosen.

 Answers as you type. That is affordable here and would not be over the network:
 the daemon searches its own mirror, so a keystroke costs a local query and
 still works on a train — which is the whole reason this app keeps a mirror.

 Debounced all the same, at a tenth of a second. Not to save the query but to
 save the *list*: firing on every keystroke makes the results flicker through
 three wrong answers on the way to the word somebody is typing, and a list that
 changes under a pointer is a list you cannot click.
 */
struct BlockSearch: View {
    /// Nil when dismissed without choosing.
    let pick: (Daemon.Reference?) -> Void

    @State private var text = ""
    @State private var hits: [Daemon.Reference] = []
    @State private var searching = false
    @State private var trouble: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                TextField("Search Hermes Notes…", text: $text)
                    .textFieldStyle(.plain)
                    .font(Theme.body(12))
                    .focused($focused)
                    .onSubmit { if let first = hits.first { pick(first) } }
                if searching { ProgressView().controlSize(.small) }
                Button { pick(nil) } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)

            if !hits.isEmpty {
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(hits) { hit in
                            Button { pick(hit) } label: {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(hit.title.isEmpty ? "Untitled" : hit.title)
                                        .font(Theme.body(12))
                                        .lineLimit(1)
                                    if let kind = hit.typeName, !kind.isEmpty {
                                        Text(kind).font(Theme.chrome(10)).foregroundStyle(.tertiary)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 9)
                                .padding(.vertical, 5)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxHeight: 190)
            } else if let trouble {
                Divider()
                Text(trouble)
                    .font(Theme.body(11)).foregroundStyle(.secondary)
                    .padding(.horizontal, 9).padding(.vertical, 6)
            } else if !text.isEmpty, !searching {
                Divider()
                Text("Nothing matches that.")
                    .font(Theme.body(11)).foregroundStyle(.secondary)
                    .padding(.horizontal, 9).padding(.vertical, 6)
            }
        }
        .frame(width: 280)
        .background(
            RoundedRectangle(cornerRadius: Theme.cardRadius)
                .fill(.background.opacity(0.97))
                .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
                    .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
                .shadow(color: .black.opacity(0.18), radius: 12, y: 3)
        )
        .onAppear { focused = true }
        .onChange(of: text) { now in look(for: now) }
    }

    /// The most recent thing typed, so a slow answer to an old query cannot
    /// land on top of a fast answer to a new one.
    @State private var latest = ""

    private func look(for typed: String) {
        latest = typed
        let want = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !want.isEmpty else {
            hits = []
            trouble = nil
            return
        }
        searching = true
        Task.detached(priority: .userInitiated) {
            try? await Task.sleep(nanoseconds: 100_000_000)
            await MainActor.run {
                guard latest == typed else { return }  // overtaken; let the newer one answer
                do {
                    hits = try Daemon.find(want)
                    trouble = nil
                } catch {
                    hits = []
                    trouble = "Talaria could not reach its own daemon."
                }
                searching = false
            }
        }
    }
}
