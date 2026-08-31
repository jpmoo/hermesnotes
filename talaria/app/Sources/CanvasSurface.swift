import AppKit
import SwiftUI

// MARK: - What is on the canvas

/**
 One thing on the canvas.

 Deliberately not a Hermes block, a sticky note, or anything else with a name in
 somebody else's vocabulary. The canvas knows about items with a position, a
 size and some words; what those turn out to *be* when they are stored is a
 question for the store below, and the canvas is not allowed to have an opinion
 about it.

 That separation is the experiment. An app that grows a surface and then teaches
 that surface to speak one server's dialect has bound the two together, and every
 later feature pays for it. So this one is built the other way round: the surface
 is finished and unaware, and the format is fitted behind it afterwards through
 `CanvasStore`. If that fitting turns out to be hard, the format is what needs
 the work — which is exactly the thing worth finding out, and impossible to find
 out from a surface that was drawn around the answer.
 */
/**
 The outline drawn round an item, if any.

 An outline and not a fill: the first rule this canvas was given is that text
 has no background, and a shape is a line round the outside rather than a
 licence to paint behind the words.

 `plain` is the original text item and stays the default. It is in the list
 because a submenu that can put an outline on and not take it off again is a
 one-way door.
 */
enum CanvasShape: String, Codable, CaseIterable, Identifiable {
    case plain
    case rectangle
    case roundedRectangle
    case triangle
    case ellipse

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .plain: return "textformat"
        case .rectangle: return "square"
        case .roundedRectangle: return "app"
        case .triangle: return "triangle"
        case .ellipse: return "circle"
        }
    }

    var name: String {
        switch self {
        case .plain: return "Plain"
        case .rectangle: return "Square"
        case .roundedRectangle: return "Rounded"
        case .triangle: return "Triangle"
        case .ellipse: return "Circle"
        }
    }

    /// A shape wants room inside it. A bare label has no size of its own — see
    /// `CanvasItem.measure`, which gives it the size of what it says.
    var defaultSize: CGSize {
        self == .plain ? CanvasItem.measure("") : CGSize(width: 130, height: 90)
    }

    /// The outline, in a box.
    func path(in r: CGRect) -> Path {
        switch self {
        case .plain:
            return Path()
        case .rectangle:
            return Path(r)
        case .roundedRectangle:
            return Path(roundedRect: r, cornerRadius: min(14, min(r.width, r.height) / 4))
        case .ellipse:
            return Path(ellipseIn: r)
        case .triangle:
            var p = Path()
            p.move(to: CGPoint(x: r.midX, y: r.minY))
            p.addLine(to: CGPoint(x: r.maxX, y: r.maxY))
            p.addLine(to: CGPoint(x: r.minX, y: r.maxY))
            p.closeSubpath()
            return p
        }
    }
}

struct CanvasItem: Identifiable, Equatable, Codable {
    let id: UUID
    var x: CGFloat
    var y: CGFloat
    var w: CGFloat
    var h: CGFloat
    var text: String
    /// Absent in a file written before shapes existed, which reads as `plain` —
    /// which is what everything in such a file is.
    var shape: CanvasShape = .plain

    /// The box in canvas coordinates.
    var rect: CGRect {
        get { CGRect(x: x, y: y, width: w, height: h) }
        set {
            x = newValue.minX
            y = newValue.minY
            w = newValue.width
            h = newValue.height
        }
    }

    /**
     How big a bare label is: exactly as big as what it says.

     A text item has no size anybody chose — it is words on a canvas, and a box
     around them that is bigger or smaller than they are is a box that shows.
     So the size is measured from the text rather than stored as an intention,
     and it is kept in step as the words are typed rather than only at the end,
     because a caret that runs out of its own box while somebody is still
     writing in it is worse than a box that grows.

     Measured with the same font it is drawn in. A number worked out from a
     character count would drift on every letter that is not an average one.

     The minimum is a caret's worth of room. An item with nothing in it yet is
     about to have something in it, and a zero-width box has nowhere to put the
     cursor.
     */
    static func measure(_ text: String) -> CGSize {
        let font = NSFont.systemFont(ofSize: 12)
        let lines = text.isEmpty ? [""] : text.components(separatedBy: .newlines)
        let widest = lines
            .map { ($0 as NSString).size(withAttributes: [.font: font]).width }
            .max() ?? 0
        let lineHeight = font.ascender - font.descender + font.leading
        return CGSize(
            width: max(widest.rounded(.up) + 4, 24),
            height: max((lineHeight * CGFloat(lines.count)).rounded(.up) + 2, 18)
        )
    }

    init(id: UUID, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, text: String, shape: CanvasShape = .plain) {
        self.id = id
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.text = text
        self.shape = shape
    }

    /**
     Written out by hand for one line of it.

     Swift's synthesised decoder requires every non-optional key to be present,
     default value or not — so adding `shape` to this struct would have made
     every canvas.json written before shapes existed fail to decode. The store
     keeps a file it cannot read rather than overwriting it, which is the right
     behaviour and would still have looked, to somebody who had just drawn a
     diagram, exactly like losing it.

     A field added to a stored shape needs a decoder that can do without it. That
     is true of the next field too, so this stays.
     */
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        x = try c.decode(CGFloat.self, forKey: .x)
        y = try c.decode(CGFloat.self, forKey: .y)
        w = try c.decode(CGFloat.self, forKey: .w)
        h = try c.decode(CGFloat.self, forKey: .h)
        text = try c.decode(String.self, forKey: .text)
        shape = try c.decodeIfPresent(CanvasShape.self, forKey: .shape) ?? .plain
    }
}

/**
 A line from one item to another.

 `from` and `to` are not symmetrical: the arrowhead is drawn at `to`, and `to`
 is whatever was dropped *on*. That is the whole content of the gesture — you
 carried this thing to that thing — so the direction is not a separate decision
 anybody has to make afterwards.

 **The bend is an offset, not a place.** It says how far the midpoint has been
 pulled off the straight line, measured from the point halfway between the two
 items' centres. Storing where the handle *is* would be simpler and wrong: move
 either item and the curve would stay behind, hanging off nothing. Storing how
 far it was pulled means the curve travels with what it connects, which is what
 anybody who bent it meant.

 Nothing here says which edges the line leaves and arrives at, deliberately.
 That is worked out from where the two items are every time it is drawn, because
 it is a fact about their positions and not a decision somebody made — storing it
 would mean a line still pointing east at a box that has since moved west.
 */
struct CanvasLink: Identifiable, Equatable, Codable {
    let id: UUID
    var from: UUID
    var to: UUID
    /// Straight when zero.
    var bendX: CGFloat = 0
    var bendY: CGFloat = 0

    var bend: CGSize {
        get { CGSize(width: bendX, height: bendY) }
        set { bendX = newValue.width; bendY = newValue.height }
    }
}

/**
 Everything on the canvas, as one thing to save.

 A document rather than two lists side by side, because a link naming an item
 that is not in the same file is a line to nowhere — and the only way to
 guarantee they are written together is for them to be one value.
 */
struct CanvasDocument: Equatable, Codable {
    var items: [CanvasItem] = []
    var links: [CanvasLink] = []
}

/**
 Where the canvas keeps what is on it.

 One method each way and nothing else, because everything else is somebody's
 storage showing through. No ids that mean something elsewhere, no versions, no
 conflicts, no network — a store that could not be implemented over a piece of
 paper is a store that has already leaked.

 There is one implementation today and it is memory. The one that matters comes
 later and speaks pkm-interchange; when it arrives, nothing above this line
 changes, and if something has to, that is the finding.
 */
protocol CanvasStore {
    func load() -> CanvasDocument
    func save(_ document: CanvasDocument)
}

/**
 The canvas, for as long as the app is running. For tests, and for a canvas
 nobody wants kept.
 */
final class MemoryCanvasStore: CanvasStore {
    private var document = CanvasDocument()
    func load() -> CanvasDocument { document }
    func save(_ document: CanvasDocument) { self.document = document }
}

/**
 The canvas, on disk.

 One JSON file beside the config and the mirror, in Talaria's own directory. A
 file you can `cat`, copy to another machine, and delete when you want the
 canvas gone — which is worth more than a canvas hidden in a defaults database,
 for the same reason the config is a file.

 Unlike everything else on the desk, this survives a reboot. That is a
 deliberate difference rather than an inconsistency: which pane you were looking
 at is a fact about an afternoon, and a diagram somebody drew is work.

 **Written by rename.** The bytes go to a neighbouring file and that file is
 moved over this one, so a crash or a power cut during a write leaves the
 previous canvas intact rather than half of two. Saving happens once per
 gesture — on a commit, on a drag letting go — never per frame, so this is a
 handful of writes a minute and not a hundred a second.

 **A file that will not parse is moved aside, not deleted.** A canvas that fails
 to load is somebody's work that this version could not read, and the one thing
 it must not do is quietly start empty over the top of it.
 */
final class FileCanvasStore: CanvasStore {
    private let url: URL

    init(url: URL = FileCanvasStore.defaultURL) {
        self.url = url
    }

    static var defaultURL: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/Talaria/canvas.json")
    }

    func load() -> CanvasDocument {
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return CanvasDocument() }
        do {
            return try JSONDecoder().decode(CanvasDocument.self, from: data)
        } catch {
            // The first shape this file had was a bare array of items, written
            // before there was anything to connect. Read it rather than treating
            // it as damage: somebody's canvas from this morning is not a corrupt
            // file, and moving it aside would be losing work over a version
            // number nobody was told about.
            if let items = try? JSONDecoder().decode([CanvasItem].self, from: data) {
                return CanvasDocument(items: items, links: [])
            }
            // Kept, under a name that says what happened. Starting empty is the
            // right thing to draw and the wrong thing to write, and without this
            // the first save would overwrite whatever could not be read.
            let aside = url.deletingPathExtension().appendingPathExtension("unreadable.json")
            try? FileManager.default.removeItem(at: aside)
            try? FileManager.default.moveItem(at: url, to: aside)
            NSLog("talaria: canvas.json could not be read (\(error)) — kept as \(aside.lastPathComponent)")
            return CanvasDocument()
        }
    }

    func save(_ document: CanvasDocument) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            // Readable on purpose. The file is small, somebody will open it, and
            // a diff of one moved item should be one line rather than the whole
            // canvas on a single line.
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(document).write(to: url, options: .atomic)
        } catch {
            NSLog("talaria: could not save the canvas (\(error))")
        }
    }
}

/**
 What is on the canvas, and what is being done to it.

 The interaction state lives here rather than in the view for one reason: a drag
 that starts on an item and a drag that starts on the background are the same
 gesture to SwiftUI, and the thing that tells them apart has to outlive both.
 */
@MainActor
final class CanvasModel: ObservableObject {
    @Published private(set) var items: [CanvasItem] = []
    @Published private(set) var links: [CanvasLink] = []
    /// A selected line. Never both this and `selected` — one selection, two
    /// kinds of thing it can be on.
    @Published var selectedLink: UUID?
    /// Under the pointer. Highlighted, and nothing more.
    @Published var hovered: UUID?
    /// Clicked. Gets the resize handles.
    @Published var selected: UUID?
    /// Being typed into. At most one, and it is never also `selected` — a thing
    /// you are writing in does not also need corners to drag.
    @Published var editing: UUID?
    /// The words as they are being typed, held apart from the item so that
    /// abandoning an edit is a matter of not committing rather than of undoing.
    @Published var draft = ""

    private let store: CanvasStore

    init(store: CanvasStore = FileCanvasStore()) {
        self.store = store
        let document = store.load()
        items = document.items
        // A line whose ends are not both here cannot be drawn and must not be
        // kept — it would be saved back out and outlive every chance of ever
        // meaning anything again.
        let present = Set(document.items.map(\.id))
        links = document.links.filter { present.contains($0.from) && present.contains($0.to) }
        // A canvas written before labels sized themselves has boxes that do not
        // match their words. Brought into line on the way in rather than left to
        // be noticed as a stray gap beside somebody's text.
        for item in items where item.shape == .plain {
            fitToText(item.id, text: item.text)
        }
    }

    private func persist() { store.save(CanvasDocument(items: items, links: links)) }

    func item(_ id: UUID) -> CanvasItem? { items.first { $0.id == id } }

    /**
     Connect two items, arrow pointing at the one that was dropped on.

     One line per pair, in one direction. Dropping A on B when B is already
     joined to A turns the existing line round rather than drawing a second one
     on top of it — two lines between the same two boxes are indistinguishable
     on screen, and the second is a line nobody can select or remove.
     */
    func link(from: UUID, to: UUID) {
        guard from != to else { return }
        if let at = links.firstIndex(where: {
            ($0.from == from && $0.to == to) || ($0.from == to && $0.to == from)
        }) {
            links[at].from = from
            links[at].to = to
        } else {
            links.append(CanvasLink(id: UUID(), from: from, to: to))
        }
        persist()
    }

    func bend(_ id: UUID, by offset: CGSize) {
        guard let at = links.firstIndex(where: { $0.id == id }) else { return }
        links[at].bend = offset
    }

    func removeLink(_ id: UUID) {
        links.removeAll { $0.id == id }
        if selectedLink == id { selectedLink = nil }
        persist()
    }

    /// Default size for a new text item: wide enough for a few words, tall
    /// enough for one line at twelve point. It grows when somebody resizes it,
    /// and never on its own — a box that resized itself while being typed into
    /// would move the words out from under the cursor.
    static let newItemSize = CGSize(width: 180, height: 24)

    /**
     Drop a new text item, centred on where the tool was let go, and start
     typing in it.

     It is a real item from this moment, which is what lets everything else —
     hover, selection, the commit rules — treat it like any other. The rule that
     an empty one disappears is what makes that safe: nothing is left behind by
     a drag somebody thought better of.
     */
    func addText(at point: CGPoint, shape: CanvasShape = .plain) {
        let size = shape.defaultSize
        let item = CanvasItem(
            id: UUID(),
            x: point.x - size.width / 2,
            y: point.y - size.height / 2,
            w: size.width,
            h: size.height,
            text: "",
            shape: shape
        )
        items.append(item)
        selected = nil
        selectedLink = nil
        draft = ""
        editing = item.id
        // Not persisted yet. An item with no words in it is a gesture in
        // progress, not a thing somebody made.
    }

    /// Start editing something already there.
    func beginEditing(_ id: UUID) {
        guard let item = items.first(where: { $0.id == id }) else { return }
        selected = nil
        selectedLink = nil
        draft = item.text
        editing = id
    }

    /**
     Finish an edit — by pressing Return, or by clicking somewhere else.

     Empty means gone, "as if it was never dragged". That rule is what makes the
     drop-then-type gesture safe to start: the cost of dropping one by accident
     is a click somewhere else, rather than a stray empty box to find and remove.
     Whitespace counts as empty, because a space bar pressed while deciding what
     to write is not a decision to keep it.

     **Except for a shape, which is a thing whether or not it says anything.**
     An empty plain-text item is literally nothing on screen and removing it
     costs nobody anything; an empty circle is a circle, and a diagram made of
     unlabelled boxes is an ordinary diagram. Deleting those would mean the only
     way to draw a box is to write something in it.

     That is an interpretation rather than an instruction — the rule was given
     when text was the only thing this could make — so it is written down here
     as one.
     */
    func commitEdit() {
        guard let id = editing else { return }
        editing = nil
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let drawsSomething = items.first(where: { $0.id == id })?.shape != .plain
        guard !text.isEmpty || drawsSomething else {
            items.removeAll { $0.id == id }
            links.removeAll { $0.from == id || $0.to == id }
            draft = ""
            persist()
            return
        }
        if let at = items.firstIndex(where: { $0.id == id }) {
            items[at].text = draft
        }
        fitToText(id, text: draft)
        draft = ""
        persist()
    }

    /**
     Keep a bare label the size of what it says.

     Called as the words change rather than only when they are committed, and it
     grows about the item's own top-left rather than its centre — text that
     shuffled sideways under the caret with every letter would be unusable.
     */
    func fitToText(_ id: UUID, text: String) {
        guard let at = items.firstIndex(where: { $0.id == id }), items[at].shape == .plain else { return }
        let size = CanvasItem.measure(text)
        items[at].w = size.width
        items[at].h = size.height
    }

    func move(_ id: UUID, to origin: CGPoint) {
        guard let at = items.firstIndex(where: { $0.id == id }) else { return }
        items[at].x = origin.x
        items[at].y = origin.y
    }

    /// Minimum size. Small enough to label a point on a diagram, big enough that
    /// a resize cannot leave something on the canvas too small to grab again.
    static let minimumSize = CGSize(width: 32, height: 18)

    func resize(_ id: UUID, to rect: CGRect) {
        guard let at = items.firstIndex(where: { $0.id == id }) else { return }
        var box = rect
        box.size.width = max(box.size.width, Self.minimumSize.width)
        box.size.height = max(box.size.height, Self.minimumSize.height)
        items[at].rect = box
    }

    /// A drag or a resize has finished. Separate from the moving itself so that
    /// a store is written once per gesture rather than once per frame.
    func settled() { persist() }

    func delete(_ id: UUID) {
        items.removeAll { $0.id == id }
        // A line to something that is gone is a line to nowhere.
        links.removeAll { $0.from == id || $0.to == id }
        if selected == id { selected = nil }
        if editing == id { editing = nil }
        persist()
    }
}

// MARK: - Where a line runs

/**
 The shape of one line, worked out from where its two items are right now.

 Nothing about this is stored. Which edge a line leaves and which it arrives at
 is a fact about two positions, and a stored answer is a line still pointing east
 at a box that has since moved west — so it is recomputed every time it is drawn,
 every time either box moves, and every time the curve is pulled.

 **Closest edge to closest edge, measured toward the bend.** Each end anchors at
 the middle of whichever of its four sides faces the point the line is heading
 for. With no bend that point is halfway between the two centres, which gives the
 sides that face each other. Pull the handle up and over, and both ends
 re-anchor to their top edges on the way — which is the behaviour asked for, and
 it falls out rather than being a case.

 **The curve passes through the handle**, which is the other thing that has to be
 true and is not automatic. A quadratic Bézier does *not* pass through its
 control point: at the halfway mark it sits at `(start + 2·control + end)/4`. So
 the control point is solved backwards from where the handle is, and the line
 goes where it was put.
 */
struct LinkGeometry {
    let start: CGPoint
    let end: CGPoint
    /// The Bézier's control point — where the maths wants it, not where the
    /// handle is.
    let control: CGPoint
    /// Where the handle is, and where the curve actually passes.
    let handle: CGPoint

    /// The middle of each of a box's four sides. The only four places a line
    /// is ever allowed to touch a box.
    static func sideCentres(_ r: CGRect) -> [CGPoint] {
        [
            CGPoint(x: r.midX, y: r.minY),
            CGPoint(x: r.midX, y: r.maxY),
            CGPoint(x: r.minX, y: r.midY),
            CGPoint(x: r.maxX, y: r.midY),
        ]
    }

    /**
     Whichever side centre is nearest.

     Plain distance between the four centres and the point the line is heading
     for — the side is chosen by where its middle is, and nothing else about the
     side is considered.

     Worth knowing what this does at the edges, because it is not the rule most
     canvas tools use. On a box much wider than it is tall, the north and south
     centres sit close together near the middle and the east and west ones are
     far out to the sides, so a handle pulled a long way up and moderately to
     the right can still be nearer the east centre than the north one — and the
     line leaves sideways out of a curve heading upwards. That is the rule doing
     exactly what it says; it is only surprising if you expected the line to
     follow the direction of travel rather than the geometry.
     */
    private static func nearestSide(of r: CGRect, to p: CGPoint) -> CGPoint {
        sideCentres(r).min { a, b in
            hypot(a.x - p.x, a.y - p.y) < hypot(b.x - p.x, b.y - p.y)
        } ?? CGPoint(x: r.midX, y: r.midY)
    }

    static func of(from: CGRect, to: CGRect, bend: CGSize) -> LinkGeometry {
        let midCentres = CGPoint(
            x: (from.midX + to.midX) / 2 + bend.width,
            y: (from.midY + to.midY) / 2 + bend.height
        )
        let a = nearestSide(of: from, to: midCentres)
        let b = nearestSide(of: to, to: midCentres)
        // Solved so that the curve passes through `midCentres` at its halfway
        // point. With no bend this lands exactly on the straight line between
        // the anchors, so a straight line stays straight.
        let control = CGPoint(x: 2 * midCentres.x - (a.x + b.x) / 2,
                              y: 2 * midCentres.y - (a.y + b.y) / 2)
        return LinkGeometry(start: a, end: b, control: control, handle: midCentres)
    }

    func point(at t: CGFloat) -> CGPoint {
        let u = 1 - t
        return CGPoint(
            x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
            y: u * u * start.y + 2 * u * t * control.y + t * t * end.y
        )
    }

    /// The direction the line is travelling as it arrives, for the arrowhead.
    var arrival: CGVector {
        let dx = 2 * (end.x - control.x)
        let dy = 2 * (end.y - control.y)
        let len = max(hypot(dx, dy), 0.0001)
        return CGVector(dx: dx / len, dy: dy / len)
    }

    /// How far a point is from the line. Sampled rather than solved: a cubic
    /// root-find would be exact and this is a click test, where twenty-four
    /// samples along a curve a few hundred points long is already finer than
    /// anybody can aim.
    func distance(to p: CGPoint) -> CGFloat {
        var best = CGFloat.greatestFiniteMagnitude
        for i in 0...24 {
            let q = point(at: CGFloat(i) / 24)
            best = min(best, hypot(q.x - p.x, q.y - p.y))
        }
        return best
    }
}

// MARK: - The pointer

/**
 The pointer, said in the pointer.

 A canvas is a thing you grab, and the cursor is where that gets communicated:
 an open hand over it, a closed one while you are pulling it about, a pointing
 finger the moment a button goes down on something. SwiftUI has no vocabulary
 for this, so the cursor is set on an AppKit view underneath and the gesture
 above tells it which one.

 `cursorUpdate` rather than `resetCursorRects`: rects are recalculated by the
 window at moments of its own choosing, which is fine for a static cursor and
 useless for one that changes mid-drag.
 */
struct CursorArea: NSViewRepresentable {
    let cursor: NSCursor

    final class Tracking: NSView {
        var cursor: NSCursor = .arrow {
            didSet {
                guard cursor != oldValue else { return }
                // The pointer is already inside; nothing will ask again until it
                // moves, so it is set now as well as declared for later.
                cursor.set()
                window?.invalidateCursorRects(for: self)
            }
        }
        override func resetCursorRects() { addCursorRect(bounds, cursor: cursor) }
        override func cursorUpdate(with event: NSEvent) { cursor.set() }
        override var acceptsFirstResponder: Bool { false }
        // Transparent to everything else: this view exists to answer one
        // question and must not take a click away from the gesture above it.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> Tracking {
        let v = Tracking()
        v.cursor = cursor
        return v
    }

    func updateNSView(_ view: Tracking, context: Context) { view.cursor = cursor }
}

// MARK: - The tools

/**
 What you can put on the canvas.

 A list rather than a switch, so adding the second tool is adding a case and
 nothing else. Each carries its own icon and its own word, because an icon strip
 with no words is a memory test — and this one is down the side of a surface
 people will use occasionally, which is the worst case for remembering what a
 glyph meant.
 */
enum CanvasTool: String, CaseIterable, Identifiable {
    case text

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .text: return "textformat"
        }
    }

    var name: String {
        switch self {
        case .text: return "Text"
        }
    }

    var hint: String {
        switch self {
        case .text: return "Drag onto the canvas to write"
        }
    }
}

/**
 The tools, down the right-hand edge.

 On the right because the canvas is the work and the tools are not: a strip on
 the left is read first, and this should be read when it is wanted. Vertical
 because it grows downward as tools are added, and a row that grows sideways
 eventually meets the zoom control in the corner.

 Dragging rather than clicking. A click would have to mean "put one somewhere",
 and the only somewhere it could pick is the middle — so every item would arrive
 in the same place and be dragged away from it. Dragging says where in the same
 motion that says what.
 */
/**
 The corner that says there is more here.

 A small filled triangle in the bottom-left of a tool, which is the oldest
 convention there is for "this one opens something" — a Mac has been drawing it
 on palette tools since before most of the alternatives were invented, and it
 costs six points of a button nobody was using.
 */
private struct SubmenuCorner: View {
    var body: some View {
        Path { p in
            p.move(to: CGPoint(x: 0, y: 6))
            p.addLine(to: CGPoint(x: 6, y: 6))
            p.addLine(to: CGPoint(x: 0, y: 0))
            p.closeSubpath()
        }
        .fill(Color.primary)
        .frame(width: 6, height: 6)
        .padding(.leading, 3)
        .padding(.bottom, 3)
    }
}

/// The shapes, offered to the left of the tool they belong to.
private struct ShapeMenu: View {
    @Binding var chosen: CanvasShape
    let close: () -> Void

    var body: some View {
        VStack(spacing: 2) {
            ForEach(CanvasShape.allCases) { shape in
                Button {
                    chosen = shape
                    close()
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: shape.symbol)
                            .font(.system(size: 12, weight: .medium))
                            .frame(width: 16)
                        Text(shape.name).font(Theme.chrome(11))
                        Spacer(minLength: 0)
                    }
                    .frame(width: 96, height: 24)
                    .contentShape(Rectangle())
                    .foregroundStyle(chosen == shape ? Theme.accent : Color.primary.opacity(0.85))
                    .background(
                        RoundedRectangle(cornerRadius: 5)
                            .fill(chosen == shape ? Color.primary.opacity(0.08) : .clear)
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: 9)
                .fill(.background.opacity(0.92))
                .overlay(
                    RoundedRectangle(cornerRadius: 9)
                        .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
        )
    }
}

private struct CanvasToolStrip: View {
    /// Which tool is being dragged. The *where* is reported in screen
    /// coordinates and converted by the surface.
    ///
    /// Global rather than a named space, which is what the first version used
    /// and why the first version did not work. `.coordinateSpace(name:)` was
    /// applied to the canvas and this strip is an overlay *on* the canvas, so
    /// the name did not resolve from in here — and an unresolved name does not
    /// fail, it quietly falls back to the gesture view's own space. That view is
    /// a 44-point button, so every drop reported a point a few tens of points
    /// from its own top-left corner, which converted to very nearly the same
    /// spot on the canvas every time. Hence: dropped in the corner, wherever you
    /// let go. Screen coordinates cannot be misresolved.
    @Binding var dragging: CanvasTool?
    @Binding var shape: CanvasShape
    @Binding var menuOpen: Bool
    let track: (CanvasTool, CGPoint) -> Void
    let drop: (CanvasTool, CGPoint) -> Void

    var body: some View {
        VStack(spacing: 6) {
            ForEach(CanvasTool.allCases) { tool in
                VStack(spacing: 2) {
                    // The tool wears what it will place, so the strip says what
                    // the next drag is going to do rather than making somebody
                    // open the menu to find out.
                    Image(systemName: tool == .text ? shape.symbol : tool.symbol)
                        .font(.system(size: 15, weight: .medium))
                    Text(tool == .text ? shape.name : tool.name)
                        .font(Theme.chrome(9, weight: .medium))
                        // "Triangle" is the longest word this will ever hold and
                        // it decides the width. The scale factor is for the one
                        // after that, so a new shape name cannot silently
                        // truncate itself.
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                .frame(width: 56, height: 40)
                .overlay(alignment: .bottomLeading) {
                    if tool == .text { SubmenuCorner() }
                }
                .contentShape(Rectangle())
                .foregroundStyle(dragging == tool ? Theme.accent : Color.secondary)
                .background(
                    RoundedRectangle(cornerRadius: 7)
                        .fill(dragging == tool ? Color.primary.opacity(0.08) : .clear)
                )
                .help(tool.hint)
                .gesture(
                    DragGesture(minimumDistance: 0, coordinateSpace: .global)
                        .onChanged { value in
                            dragging = tool
                            track(tool, value.location)
                        }
                        .onEnded { value in
                            dragging = nil
                            // A press that went nowhere is a click, and a click
                            // on a tool with a corner opens what is behind it.
                            // The two cannot both be "place one": a click has no
                            // position to place it at except the middle, which
                            // is the argument for dragging in the first place.
                            let moved = abs(value.translation.width) > 4
                                || abs(value.translation.height) > 4
                            if moved {
                                menuOpen = false
                                drop(tool, value.location)
                            } else if tool == .text {
                                menuOpen.toggle()
                            }
                        }
                )
            }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 4)
        .background(
            RoundedRectangle(cornerRadius: 11)
                .fill(.background.opacity(0.65))
                .overlay(
                    RoundedRectangle(cornerRadius: 11)
                        .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1)
                )
        )
        // To the left, because the strip is already against the right-hand edge
        // and a menu opening outward would open off the canvas.
        .overlay(alignment: .topTrailing) {
            if menuOpen {
                ShapeMenu(chosen: $shape) { menuOpen = false }
                    .fixedSize()
                    .offset(x: -56)
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
            }
        }
    }
}

// MARK: - One item

/**
 A text item: the words, and nothing else.

 No border and no background, deliberately and on instruction — a caption on a
 diagram is not a card, and drawing a box around it says it is a thing when it is
 a label. Everything that *is* drawn around it appears only while somebody is
 pointing at it or has selected it, and goes away again.

 Twelve point, in whatever the system face is. Not a choice this surface makes on
 anybody's behalf: it is the size text is, until somebody asks for another one.
 */
private struct CanvasItemView: View {
    let item: CanvasItem
    let zoom: CGFloat
    let hovered: Bool
    let selected: Bool
    let editing: Bool
    /// Letting go now would draw a line to this one.
    let dropTarget: Bool
    @Binding var draft: String
    let commit: () -> Void
    /// Told the words; decides the box. Only a bare label has one.
    let fit: (String) -> Void

    @FocusState private var focused: Bool

    /// Chrome is drawn in screen terms, not canvas terms.
    ///
    /// A one-point outline inside a transform is a sixth of a point at 0.15×
    /// and six points at 6×. Dividing by the zoom keeps every line and every
    /// handle the same size on the glass whatever the canvas is doing, which is
    /// what a person means by "a thin outline".
    private var hairline: CGFloat { 1 / zoom }
    private var handle: CGFloat { 7 / zoom }

    var body: some View {
        ZStack(alignment: .center) {
            // The outline. A stroke and nothing else — no fill, because the
            // rule this canvas started from is that text has no background, and
            // a shape is a line round the outside rather than permission to
            // paint behind the words.
            if item.shape != .plain {
                item.shape
                    .path(in: CGRect(x: 0, y: 0, width: item.w, height: item.h).insetBy(dx: hairline, dy: hairline))
                    .stroke(Color.primary.opacity(0.7), lineWidth: 1.5 * hairline)
            }
            if editing {
                TextField("", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .focused($focused)
                    // Return commits, and has to be caught before the field
                    // sees it. `onSubmit` is the obvious spelling and does not
                    // fire on a vertical-axis field on macOS: the axis is what
                    // makes the words wrap in the box, and it also makes Return
                    // mean "new line". Both are wanted, so the key is taken
                    // first and the field never learns it was pressed.
                    .onKeyPress(.return) {
                        commit()
                        return .handled
                    }
                    .multilineTextAlignment(.center)
                    .onAppear { focused = true }
                    // The box follows the words as they are written, not only
                    // when they are finished — a caret that runs out of its own
                    // box mid-sentence is the thing this is for.
                    .onChange(of: draft) { now in fit(now) }
                    // Losing focus is "clicking away", which commits by the same
                    // rule as Return. Both are somebody saying they are done;
                    // neither is somebody saying to throw it away.
                    .onChange(of: focused) { now in if !now { commit() } }
            } else {
                Text(item.text)
                    .font(.system(size: 12))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    // Room to breathe inside a shape, and none around a bare
                    // label — a label with padding is a label that does not
                    // start where it looks like it starts.
                    .padding(item.shape == .plain ? 0 : 10)
            }
        }
        .frame(width: item.w, height: item.h, alignment: .center)
        // The whole box answers the pointer, not just the letters. A label with
        // one short word in a wide box would otherwise be nearly unhittable, and
        // "touching an item highlights it" would be a lie most of the time.
        .contentShape(Rectangle())
        .overlay {
            // Hover is the faintest thing that can be seen; selection is
            // definite. They are the same rectangle at two strengths rather than
            // two different marks, because they are two stages of one idea.
            if dropTarget {
                // The strongest mark on the canvas, and the only one that is
                // filled. Dropping a box on a box is a gesture whose outcome is
                // invisible until it has happened — the thing you are carrying
                // goes back where it came from and a line appears somewhere
                // else — so what it is going to connect to has to be in no
                // doubt before you let go.
                RoundedRectangle(cornerRadius: 3 / zoom)
                    .fill(Theme.accent.opacity(0.14))
                    .overlay(
                        RoundedRectangle(cornerRadius: 3 / zoom)
                            .strokeBorder(Theme.accent, lineWidth: 2 * hairline)
                    )
            } else if editing {
                RoundedRectangle(cornerRadius: 3 / zoom)
                    .strokeBorder(Theme.accent.opacity(0.55), style: StrokeStyle(lineWidth: hairline, dash: [3 / zoom, 2 / zoom]))
            } else if selected {
                RoundedRectangle(cornerRadius: 3 / zoom)
                    .strokeBorder(Theme.accent, lineWidth: hairline)
            } else if hovered {
                RoundedRectangle(cornerRadius: 3 / zoom)
                    .strokeBorder(Color.primary.opacity(0.28), lineWidth: hairline)
            }
        }
    }

    /// Where the four grips sit, in the item's own space.
    static func corners(_ item: CanvasItem) -> [(Corner, CGPoint)] {
        [
            (.topLeading, CGPoint(x: 0, y: 0)),
            (.topTrailing, CGPoint(x: item.w, y: 0)),
            (.bottomLeading, CGPoint(x: 0, y: item.h)),
            (.bottomTrailing, CGPoint(x: item.w, y: item.h)),
        ]
    }

    enum Corner: Hashable {
        case topLeading, topTrailing, bottomLeading, bottomTrailing

        /// The box that results from dragging this corner by `delta`.
        ///
        /// The opposite corner is the fixed point, which is what makes a resize
        /// feel like pulling the edge you have hold of rather than moving the
        /// whole thing.
        func applied(to rect: CGRect, by delta: CGSize) -> CGRect {
            var r = rect
            switch self {
            case .topLeading:
                r.origin.x += delta.width
                r.origin.y += delta.height
                r.size.width -= delta.width
                r.size.height -= delta.height
            case .topTrailing:
                r.origin.y += delta.height
                r.size.width += delta.width
                r.size.height -= delta.height
            case .bottomLeading:
                r.origin.x += delta.width
                r.size.width -= delta.width
                r.size.height += delta.height
            case .bottomTrailing:
                r.size.width += delta.width
                r.size.height += delta.height
            }
            return r
        }
    }
}

// MARK: - The surface

/**
 An infinite canvas, with things on it.

 One transform, applied once. The grid, the items and everything that comes
 later read `zoom` and `pan` rather than keeping a copy, because two things that
 each remember where the viewport is will disagree the first time one of them is
 animated.

 Canvas coordinates have their origin at the centre of the pane when the canvas
 is at rest, which is what the zoom arithmetic in `DeskChrome` already assumes.
 Everything that converts between the two goes through `canvasPoint`, once, so
 there is one place to be wrong.
 */
struct CanvasSurface: View {
    @ObservedObject var chrome: DeskChrome
    @ObservedObject var model: CanvasModel

    /// A name for this view's coordinate space, so a drag that starts on the
    /// tool strip can report where it ended in canvas terms.
    static let space = "talaria.canvas"
    /// How much of the right-hand edge the tools occupy. One number, because a
    /// drop test and a cursor test that disagree about where the strip is will
    /// disagree in a thin stripe nobody thinks to look at.
    static let stripWidth: CGFloat = 76

    /// Where the pan was when the current drag began. A drag reports its total
    /// translation, not an increment, so without this every frame re-applies
    /// the whole gesture from the origin and the canvas leaps.
    @State private var panAtStart: CGSize?
    @State private var zoomAtStart: CGFloat?
    @State private var pressing = false
    @State private var dragging = false
    /// Where the pointer is, for zooming about it rather than about the middle.
    @State private var hover: CGPoint?
    /// A line under the pointer. Lines are strokes in a `Canvas` and have no
    /// view to hover, so this is worked out from the same hit test the click
    /// uses — one rule for what counts as being on a line, not two.
    @State private var hoveredLink: UUID?

    @State private var tool: CanvasTool?
    @State private var toolPoint: CGPoint?
    /// What the text tool will place next. Kept on the surface rather than in
    /// the model: it is a state of the tool strip, not a fact about the canvas,
    /// and a canvas reopened tomorrow should not still be armed with a triangle.
    @State private var shape: CanvasShape = .plain
    @State private var shapeMenuOpen = false

    /// The last click on an item, for telling a second one from a first.
    /// The system's own double-click interval, so this agrees with everything
    /// else the person's machine does.
    @State private var lastClick: (id: UUID, at: Date)?
    /// The item being moved, and where it started. Same reasoning as `panAtStart`.
    @State private var movingId: UUID?
    @State private var moveOrigin: CGPoint?
    @State private var resizing: (id: UUID, corner: CanvasItemView.Corner, from: CGRect)?
    /// The item a drag is currently hovering over, which dropping would link to.
    @State private var linkTarget: UUID?
    /// Where the bend was when the handle was picked up.
    @State private var bendAtStart: CGSize?

    /// Open over the canvas, pointing the instant a button goes down, closed
    /// once that press starts pulling the canvas about.
    private var cursor: NSCursor {
        if tool != nil { return .crosshair }
        // Pulling something — the canvas itself, or one thing on it.
        if dragging || movingId != nil { return .closedHand }
        // Over a thing, or pressed on the canvas. Both are "this click will do
        // something to what is under you", which is what a pointing finger has
        // always meant.
        if pressing || model.hovered != nil || hoveredLink != nil { return .pointingHand }
        return .openHand
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // The background, and the only thing that pans. Below the items
                // in the stack, so a press on an item reaches the item — which
                // is what stops "drag to move this" and "drag to move the
                // canvas" being the same gesture.
                background(geo.size)

                // Under the items, so a line runs behind the boxes it joins
                // rather than across their faces.
                lines(geo.size)

                content(geo)

                // The handle sits above everything it might otherwise hide
                // behind, and only exists while a line is selected.
                if let id = model.selectedLink,
                   let link = model.links.first(where: { $0.id == id }),
                   let g = geometry(of: link) {
                    handleControls(for: link, g: g, in: geo.size)
                }

                // The ghost. Drawn over everything, because a tool being carried
                // is not on the canvas yet and should not look as though it is.
                if let tool, let at = toolPoint {
                    Image(systemName: tool == .text ? shape.symbol : tool.symbol)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .padding(6)
                        .background(Circle().fill(.background.opacity(0.8)))
                        .position(at)
                        .allowsHitTesting(false)
                }

                CursorArea(cursor: cursor)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Every pointer move over the surface, whatever it is over —
            // an item, the background, the ghost. Two jobs: it is the anchor a
            // pinch zooms about, and it is where the cursor is re-asserted.
            //
            // Re-asserted because `NSCursor.set()` does not stick. AppKit
            // resets the cursor to the arrow whenever the pointer crosses a
            // tracking area, and a SwiftUI view hierarchy is full of them —
            // every `.help`, every button, every text field. A cursor set once
            // when the view appears is a cursor that survives until the first
            // time the pointer moves across anything, which is immediately.
            .onContinuousHover { phase in
                switch phase {
                case .active(let point):
                    hover = point
                    hoveredLink = hitLink(at: point, in: geo.size)
                    // Not over the tool strip, which is chrome and keeps the
                    // arrow — a hand over a row of buttons says they can be
                    // grabbed and dragged about, and they cannot.
                    if point.x < geo.size.width - Self.stripWidth { cursor.set() }
                // Off the surface entirely. The last known point would be an
                // edge, and zooming about an edge with the pointer somewhere
                // else is worse than zooming about the middle. The cursor is
                // left alone: it belongs to whatever the pointer is over now.
                case .ended:
                    hover = nil
                    hoveredLink = nil
                @unknown default:
                    hover = nil
                    hoveredLink = nil
                }
            }
            .overlay(alignment: .trailing) {
                CanvasToolStrip(
                    dragging: $tool,
                    shape: $shape,
                    menuOpen: $shapeMenuOpen,
                    track: { _, at in toolPoint = local(at, geo) },
                    drop: { which, at in
                        let here = local(at, geo)
                        toolPoint = nil
                        switch which {
                        case .text:
                            // Ignore a drop that never left the strip: that is a
                            // click on a tool, and a click has nowhere to put one.
                            guard here.x < geo.size.width - Self.stripWidth else { return }
                            model.addText(at: canvasPoint(here, in: geo.size), shape: shape)
                        }
                    }
                )
                .padding(.trailing, 10)
            }
        }
    }

    /// A point on the screen, as a point in this surface.
    private func local(_ global: CGPoint, _ geo: GeometryProxy) -> CGPoint {
        let frame = geo.frame(in: .global)
        return CGPoint(x: global.x - frame.minX, y: global.y - frame.minY)
    }

    // MARK: Coordinates

    /**
     The item under the pointer that is not the one being carried.

     Topmost wins — last drawn, so the one somebody can actually see under the
     cursor — which is why this walks the list backwards.
     */
    private func dropTarget(under screen: CGPoint, moving: UUID, in geo: GeometryProxy) -> UUID? {
        let here = canvasPoint(local(screen, geo), in: geo.size)
        return model.items.reversed().first { $0.id != moving && $0.rect.contains(here) }?.id
    }

    /**
     Which line, if any, is under a click.

     Measured in canvas points but with a tolerance converted from screen
     points, so the target stays the same size under the pointer however far the
     canvas is zoomed — six points of slack at 100% is six points of slack at
     600%, rather than one.

     Nearest wins where two lines cross, which is the only answer that is not
     arbitrary.
     */
    private func hitLink(at p: CGPoint, in size: CGSize) -> UUID? {
        let here = canvasPoint(p, in: size)
        let slack = 7 / chrome.zoom
        var best: (id: UUID, d: CGFloat)?
        for link in model.links {
            guard let g = geometry(of: link) else { continue }
            let d = g.distance(to: here)
            guard d <= slack else { continue }
            if best == nil || d < best!.d { best = (link.id, d) }
        }
        return best?.id
    }

    /// A point on the canvas, as a point on the glass. The inverse of
    /// `canvasPoint`, and the two must stay that way.
    private func screenPoint(_ p: CGPoint, in size: CGSize) -> CGPoint {
        CGPoint(x: p.x * chrome.zoom + chrome.pan.width + size.width / 2,
                y: p.y * chrome.zoom + chrome.pan.height + size.height / 2)
    }

    /// The shape of a line, or nothing if either end has gone.
    private func geometry(of link: CanvasLink) -> LinkGeometry? {
        guard let a = model.item(link.from), let b = model.item(link.to) else { return nil }
        return LinkGeometry.of(from: a.rect, to: b.rect, bend: link.bend)
    }

    /**
     Every line, drawn in screen space.

     Not inside the transform, for the same reason the grid is not: a stroke
     inside `scaleEffect` is scaled along with everything else, so a line drawn
     one point wide is a hairline at 0.15x and a six-point band at 6x. Converting
     the two ends and drawing at a constant width keeps a line looking like a
     line at every zoom, which is what it is.
     */
    @ViewBuilder
    private func lines(_ size: CGSize) -> some View {
        Canvas { context, _ in
            for link in model.links {
                guard let g = geometry(of: link) else { continue }
                let start = screenPoint(g.start, in: size)
                let end = screenPoint(g.end, in: size)
                let control = screenPoint(g.control, in: size)
                let chosen = model.selectedLink == link.id
                let under = hoveredLink == link.id
                let colour: Color = chosen ? Theme.accent : .primary.opacity(under ? 0.85 : 0.55)
                let width: CGFloat = chosen ? 2 : (under ? 2 : 1.5)

                var path = Path()
                path.move(to: start)
                path.addQuadCurve(to: end, control: control)
                context.stroke(path, with: .color(colour), lineWidth: width)

                // The head, at the end that was dropped on. Drawn as a filled
                // triangle rather than two strokes so it stays solid at any
                // angle instead of showing a notch at the point.
                let d = g.arrival
                let tip = end
                let back = CGPoint(x: tip.x - d.dx * 9, y: tip.y - d.dy * 9)
                let side = CGVector(dx: -d.dy, dy: d.dx)
                var head = Path()
                head.move(to: tip)
                head.addLine(to: CGPoint(x: back.x + side.dx * 4.5, y: back.y + side.dy * 4.5))
                head.addLine(to: CGPoint(x: back.x - side.dx * 4.5, y: back.y - side.dy * 4.5))
                head.closeSubpath()
                context.fill(head, with: .color(colour))
            }
        }
        .allowsHitTesting(false)
    }

    /// The midpoint grip, and the one button that undoes a line.
    @ViewBuilder
    private func handleControls(for link: CanvasLink, g: LinkGeometry, in size: CGSize) -> some View {
        let at = screenPoint(g.handle, in: size)
        ZStack {
            Circle()
                .fill(Color(nsColor: .windowBackgroundColor))
                .overlay(Circle().strokeBorder(Theme.accent, lineWidth: 1.5))
                .frame(width: 11, height: 11)
                .contentShape(Circle().inset(by: -7))
                .position(at)
                .gesture(
                    // Global, like every other drag here: this handle is drawn
                    // at a position that the drag itself changes.
                    DragGesture(minimumDistance: 0, coordinateSpace: .global)
                        .onChanged { value in
                            let base = bendAtStart ?? link.bend
                            if bendAtStart == nil { bendAtStart = base }
                            model.bend(link.id, by: CGSize(
                                width: base.width + value.translation.width / chrome.zoom,
                                height: base.height + value.translation.height / chrome.zoom
                            ))
                        }
                        .onEnded { _ in
                            bendAtStart = nil
                            model.settled()
                        }
                )

            // A line drawn by accident has to be undoable, and a keyboard is not
            // where somebody's hand is at that moment. Offset far enough from
            // the grip that neither is hit while reaching for the other.
            Button { model.removeLink(link.id) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 7, weight: .bold))
                    .frame(width: 13, height: 13)
                    .contentShape(Rectangle())
                    .foregroundStyle(.white)
                    .background(Circle().fill(Theme.danger))
            }
            .buttonStyle(.plain)
            .help("Remove this connection")
            .position(x: at.x + 16, y: at.y - 14)
        }
    }

    /// A point on the glass, as a point on the canvas.
    private func canvasPoint(_ p: CGPoint, in size: CGSize) -> CGPoint {
        CGPoint(
            x: (p.x - size.width / 2 - chrome.pan.width) / chrome.zoom,
            y: (p.y - size.height / 2 - chrome.pan.height) / chrome.zoom
        )
    }

    // MARK: Layers

    @ViewBuilder
    private func background(_ size: CGSize) -> some View {
        ZStack {
            if chrome.grid { grid }
            Color.clear
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    pressing = true
                    // A press is not yet a drag. Below this it is somebody
                    // clicking and the pointer says so; past it they are pulling
                    // the canvas and it becomes a fist.
                    if abs(value.translation.width) > 3 || abs(value.translation.height) > 3 {
                        dragging = true
                    }
                    // A button going down is not a pointer moving, so the hover
                    // above will not have run. Without this the hand does not
                    // close until the drag has already travelled a few points.
                    //
                    // Named outright rather than read back off `cursor`, which
                    // is computed from state written one line ago — that reads
                    // correctly today and is the kind of thing that stops
                    // reading correctly for reasons nobody can see.
                    (dragging ? NSCursor.closedHand : NSCursor.pointingHand).set()
                    guard dragging else { return }
                    let base = panAtStart ?? chrome.pan
                    if panAtStart == nil { panAtStart = base }
                    chrome.pan = CGSize(width: base.width + value.translation.width,
                                        height: base.height + value.translation.height)
                }
                .onEnded { value in
                    // A press on the background that never became a drag is
                    // "clicking away": it finishes whatever was being typed and
                    // drops the selection. This is the other half of the rule
                    // that an empty item disappears.
                    //
                    // A line first, though. A line is drawn on the background
                    // and has no view of its own to click — it is a stroke in a
                    // Canvas — so the click that would clear the selection is
                    // also the only click that can make one.
                    if !dragging {
                        model.commitEdit()
                        model.selected = nil
                        model.selectedLink = hitLink(at: value.location, in: size)
                        // A click anywhere else closes it, which is what a menu
                        // does and what somebody who opened it by accident will
                        // try first.
                        shapeMenuOpen = false
                    }
                    panAtStart = nil
                    pressing = false
                    dragging = false
                    // Back to the open hand, for the same reason: letting go is
                    // not a move either.
                    NSCursor.openHand.set()
                }
        )
        .simultaneousGesture(
            MagnificationGesture()
                .onChanged { value in
                    let base = zoomAtStart ?? chrome.zoom
                    if zoomAtStart == nil { zoomAtStart = base }
                    // About the pointer, which does not move during a pinch —
                    // and about the middle when there is no pointer over the
                    // canvas at all, which is the only sensible fallback.
                    chrome.zoom(
                        to: base * value,
                        about: hover ?? CGPoint(x: size.width / 2, y: size.height / 2),
                        in: size
                    )
                }
                .onEnded { _ in zoomAtStart = nil }
        )
    }

    @ViewBuilder
    private func content(_ geo: GeometryProxy) -> some View {
        ZStack {
            ForEach(model.items) { item in
                itemView(item, in: geo)
            }
        }
        .scaleEffect(chrome.zoom)
        .offset(chrome.pan)
    }

    @ViewBuilder
    private func itemView(_ item: CanvasItem, in geo: GeometryProxy) -> some View {
        let editing = model.editing == item.id
        let selected = model.selected == item.id

        CanvasItemView(
            item: item,
            zoom: chrome.zoom,
            hovered: model.hovered == item.id,
            selected: selected,
            editing: editing,
            dropTarget: linkTarget == item.id,
            draft: $model.draft,
            commit: { model.commitEdit() },
            fit: { model.fitToText(item.id, text: $0) }
        )
        .onHover { inside in
            if inside { model.hovered = item.id }
            else if model.hovered == item.id { model.hovered = nil }
        }
        .gesture(
            // Screen coordinates, and it matters twice over.
            //
            // A drag reports its translation in its own coordinate space, and
            // this view's space is *moving* — it is offset by the very position
            // being dragged. So each frame measured from a new origin, the
            // translation came out short, and the item trailed the pointer
            // instead of following it. The classic shape of this bug, and it
            // does not look like a coordinate problem; it looks like something
            // is slow.
            //
            // The second is the scale. Local space inside `scaleEffect` is
            // already in canvas units, so dividing by the zoom as well moved
            // the item at a fraction of pointer speed — right at 100% and
            // increasingly wrong on either side of it.
            //
            // Global space is neither scaled nor moving. One conversion, at the
            // end, and both faults are gone.
            DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { value in
                    guard !editing else { return }
                    if movingId == nil {
                        movingId = item.id
                        moveOrigin = CGPoint(x: item.x, y: item.y)
                    }
                    guard let from = moveOrigin else { return }
                    // Screen points into canvas points, once.
                    model.move(
                        item.id,
                        to: CGPoint(x: from.x + value.translation.width / chrome.zoom,
                                    y: from.y + value.translation.height / chrome.zoom)
                    )
                    // What the pointer is over, not what the box overlaps. A
                    // box being dragged overlaps whatever it happens to cross,
                    // and half of that is the diagram it is being carried
                    // across; the pointer is the one part of the gesture that
                    // is unambiguously aimed.
                    linkTarget = dropTarget(under: value.location, moving: item.id, in: geo)
                }
                .onEnded { value in
                    let moved = abs(value.translation.width) > 3 || abs(value.translation.height) > 3
                    if moved, let onto = linkTarget, let from = moveOrigin {
                        // Dropped on something. The gesture said "this one goes
                        // with that one", not "this one goes here", so the box
                        // goes back where it came from and a line is what is
                        // left behind. Leaving it where it landed would mean
                        // every connection also rearranged the diagram.
                        model.move(item.id, to: from)
                        model.link(from: item.id, to: onto)
                        model.selected = nil
                        model.selectedLink = nil
                    } else if moved {
                        model.settled()
                    } else if !editing {
                        /*
                         A press that went nowhere is a click. Whether it is the
                         *second* one is decided here rather than by a separate
                         tap gesture, which is how it was and why it did nothing.

                         A `TapGesture(count: 2)` alongside a drag that starts at
                         zero distance does fire — and then the same press ends
                         the drag, which committed the edit that had just begun.
                         Entering an edit and leaving it in one click looks
                         exactly like nothing happening. Two gestures cannot be
                         made to agree about one press, so there is one gesture
                         and it counts.
                         */
                        let now = Date()
                        let again = lastClick.map {
                            $0.id == item.id && now.timeIntervalSince($0.at) < NSEvent.doubleClickInterval
                        } ?? false
                        lastClick = (item.id, now)
                        model.commitEdit()
                        if again {
                            lastClick = nil
                            model.beginEditing(item.id)
                        } else {
                            model.selected = item.id
                        }
                    }
                    movingId = nil
                    moveOrigin = nil
                    linkTarget = nil
                }
        )

        .overlay {
            // No grips on a bare label: its size is its words, and a handle
            // that fights the thing computing the size is a control that does
            // not work rather than a control that does something else.
            if selected, item.shape != .plain { handles(item) }
        }
        .frame(width: item.w, height: item.h)
        .offset(x: item.x + item.w / 2, y: item.y + item.h / 2)
    }

    /// The four corner grips, drawn only while something is selected.
    @ViewBuilder
    private func handles(_ item: CanvasItem) -> some View {
        let side = 7 / chrome.zoom
        ForEach(CanvasItemView.corners(item), id: \.0) { corner, at in
            RoundedRectangle(cornerRadius: 1.5 / chrome.zoom)
                .fill(Color(nsColor: .windowBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: 1.5 / chrome.zoom)
                        .strokeBorder(Theme.accent, lineWidth: 1 / chrome.zoom)
                )
                .frame(width: side, height: side)
                .contentShape(Rectangle().inset(by: -side))
                .position(at)
                // Higher priority than the move drag on the item below. Both
                // start at zero distance on overlapping pixels, and without
                // this the corner is just another part of the item to drag —
                // which is a resize handle that moves things.
                .highPriorityGesture(
                    // Global, for the reason the move above is: a grip sits on
                    // the corner of the box it is resizing, so its own space
                    // moves as the box changes under it.
                    DragGesture(minimumDistance: 0, coordinateSpace: .global)
                        .onChanged { value in
                            if resizing == nil {
                                resizing = (item.id, corner, item.rect)
                            }
                            guard let start = resizing, start.id == item.id else { return }
                            let delta = CGSize(width: value.translation.width / chrome.zoom,
                                               height: value.translation.height / chrome.zoom)
                            model.resize(item.id, to: start.corner.applied(to: start.from, by: delta))
                        }
                        .onEnded { _ in
                            resizing = nil
                            model.settled()
                        }
                )
        }
    }

    /// Dots rather than lines. A ruled grid behind a diagram competes with it;
    /// dots say where the spacing is and then get out of the way.
    private var grid: some View {
        Canvas { context, size in
            let step = 24 * chrome.zoom
            // Below this the dots merge into a wash and the grid stops being
            // information — better to draw nothing than a grey field.
            guard step > 6 else { return }
            let dot = max(0.7, 1.1 * min(chrome.zoom, 1.6))
            // Anchored to the pan so the grid moves with the content rather
            // than sitting still behind it, which reads as the canvas sliding
            // over a wall.
            let originX = chrome.pan.width.truncatingRemainder(dividingBy: step)
            let originY = chrome.pan.height.truncatingRemainder(dividingBy: step)
            var y = originY - step
            while y < size.height + step {
                var x = originX - step
                while x < size.width + step {
                    context.fill(
                        Path(ellipseIn: CGRect(x: x, y: y, width: dot, height: dot)),
                        with: .color(.primary.opacity(0.22))
                    )
                    x += step
                }
                y += step
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - The chrome under it

/**
 The zoom readout, its two buttons, and the two switches that belong with it.

 The switches were in a menu behind the percentage and nobody found them, which
 is the whole argument against putting a setting somewhere it has to be
 discovered. They are buttons now, lit when they are on, sitting next to the
 thing they affect.
 */
struct CanvasControls: View {
    @ObservedObject var chrome: DeskChrome

    var body: some View {
        HStack(spacing: 2) {
            toggle("squareshape.dotted.squareshape", on: chrome.grid, help: "Dotted grid") {
                chrome.grid.toggle()
            }
            toggle("rectangle.on.rectangle.slash", on: !chrome.seeThrough, help: "Hide what is behind") {
                chrome.seeThrough.toggle()
            }
            Divider().frame(height: 14).padding(.horizontal, 3)
            button("minus", help: "Zoom out") { chrome.zoom(to: chrome.zoom / 1.25) }
            // The one thing anybody wants from a zoom readout is to be told it
            // is 100% again, so the number is the button that does it.
            Button {
                withAnimation(.easeOut(duration: 0.18)) {
                    chrome.zoom(to: 1)
                    chrome.pan = .zero
                }
            } label: {
                Text("\(Int((chrome.zoom * 100).rounded()))%")
                    .font(Theme.chrome(11, weight: .medium))
                    .monospacedDigit()
                    .frame(width: 44, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Back to actual size")
            button("plus", help: "Zoom in") { chrome.zoom(to: chrome.zoom * 1.25) }
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 3)
        .background(
            Capsule().fill(.background.opacity(0.65))
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
        )
    }

    private func toggle(_ symbol: String, on: Bool, help: String, _ act: @escaping () -> Void) -> some View {
        Button(action: act) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 22, height: 18)
                .contentShape(Rectangle())
                .foregroundStyle(on ? Theme.accent : Color.secondary)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(on ? Color.primary.opacity(0.08) : .clear)
                )
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private func button(_ symbol: String, help: String, _ act: @escaping () -> Void) -> some View {
        Button { withAnimation(.easeOut(duration: 0.14)) { act() } } label: {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 20, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
