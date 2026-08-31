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
    var symbol: String {
        switch self {
        case .solid: return "minus"
        case .dashed: return "line.3.horizontal.decrease"
        case .double: return "equal"
        }
    }

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

// MARK: - Colours, as text

/**
 A colour, stored as a hex string.

 Not as archived `NSColor` data, and not as three floats. The canvas file is
 something a person opens and reads — that is the whole argument for it being
 JSON on disk rather than a defaults key — and `"#5fa4b5"` is readable where a
 base64 blob is not. It is also the spelling every other tool uses, including
 the one this canvas will eventually be written through, so nothing has to be
 translated later.

 Nil means "whatever the theme says", which is not the same as black. This canvas
 is drawn over a frost that follows the system appearance, and a colour stored
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
        // Alpha only when it is doing something. Most colours are opaque and an
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

/// One labelled row, so every control in here lines up with every other.
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

/// A row of icons, one of which is chosen.
private struct Segmented<T: Hashable & Identifiable>: View {
    let options: [T]
    let symbol: (T) -> String
    @Binding var chosen: T

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                Button { chosen = option } label: {
                    Image(systemName: symbol(option))
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

/**
 A colour well with a way back to nothing.

 `ColorPicker` is the system control, which means the system panel, which means
 the eyedropper and the palettes and everything else a person already knows. What
 it has no idea about is "unset" — it always holds a colour — so the row carries
 its own way to say "no colour", because that is a different answer from the
 colour that happens to be showing.
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

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            if let item { itemControls(item) }
            if let link { linkControls(link) }
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
            Segmented(options: LineStyle.allCases, symbol: { $0.symbol }, chosen: style)
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
