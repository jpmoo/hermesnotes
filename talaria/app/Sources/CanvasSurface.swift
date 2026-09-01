import AppKit
import SwiftUI
import UniformTypeIdentifiers

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

    // Everything below is style, and every one of them has a default that is
    // what the canvas already looked like. A file written before any of this
    // existed decodes to exactly the canvas somebody left.
    var hAlign: TextAlign = .center
    var vAlign: TextVAlign = .middle
    /// Hex, or nothing for "whatever the theme's text color is". Nothing is not
    /// the same as black: this canvas is drawn over a frost that follows the
    /// system appearance, and a stored black would be invisible in the dark.
    var textColor: String?
    /// Shapes only. The one place this canvas paints behind anything.
    var fill: String?
    var stroke: String?
    var strokeWidth: CGFloat = 1.5
    var strokeStyle: LineStyle = .solid
    /**
     The picture this item shows, by the name the store keeps it under.

     A name and not the bytes. The canvas is one JSON file that somebody can
     open, read and copy to another machine, and a screenshot base64'd into it
     would be a megabyte of one line — a file that is technically still readable
     and that nobody will ever read again. The bytes live beside it as files,
     which is also the shape an attachment takes in every format worth mapping
     onto later.
     */
    var image: String?
    /**
     The Hermes block this node stands for, if somebody made one.

     An id and nothing else. Not a copy of the title, the type, the status or
     the icon — every one of those is a fact about the block, and a second copy
     of a fact is a copy that goes stale the first time anybody edits the
     original somewhere else. What is drawn comes from the mirror, every time.

     Deleting the node does not delete the block. A canvas is a way of talking
     about things, and taking a thing off it is not destroying the thing.
     */
    var blockId: String?

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

    private static let bodyFont = NSFont.systemFont(ofSize: 12)

    /// How wide a label will grow itself before it starts wrapping instead.
    /// Not a limit on the box — a drag can make it any width — only on how far
    /// typing alone will push it.
    static let widestAuto: CGFloat = 520

    /**
     How big a new label starts: one line, as wide as its words.

     Only ever used for the first moment of one. After that the width is
     whatever somebody has dragged it to and the height is `leastHeight` below.
     The minimum is a caret's worth of room, because an item with nothing in it
     yet is about to have something in it and a zero-width box has nowhere to
     put the cursor.
     */
    static func measure(_ text: String) -> CGSize {
        let lines = text.isEmpty ? [""] : text.components(separatedBy: .newlines)
        let widest = lines
            .map { ($0 as NSString).size(withAttributes: [.font: bodyFont]).width }
            .max() ?? 0
        return CGSize(width: max(widest.rounded(.up) + 4, 24), height: leastHeight(of: text, at: 24))
    }

    /**
     The least tall this box may be, given the words in it and how wide it is.

     A floor, not a size. The box may be bigger than its text — somebody may
     want room round a label, or may be lining it up with something else — and
     the only thing it may not be is too small to show what it says. So this is
     what a resize is clamped to and what the box grows to as the words are
     typed, and neither of those ever makes it smaller than it was.

     Wrapped, not measured a line at a time. The words reflow inside whatever
     width the box has, so the question is not how long the text is but how many
     lines it turns into at *this* width — narrow the box and the same sentence
     needs more height, which is exactly the case that has to keep up.
     */
    static func leastHeight(of text: String, at width: CGFloat) -> CGFloat {
        let usable = max(width - 4, 8)
        let measured = (text.isEmpty ? " " : text as String).boundingRect(
            with: CGSize(width: usable, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: bodyFont]
        ).height
        return max(measured.rounded(.up) + 2, 18)
    }

    init(
        id: UUID, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat,
        text: String, shape: CanvasShape = .plain, image: String? = nil
    ) {
        self.id = id
        self.x = x
        self.y = y
        self.w = w
        self.h = h
        self.text = text
        self.shape = shape
        self.image = image
    }

    /**
     Written out by hand for one line of it.

     Swift's synthesized decoder requires every non-optional key to be present,
     default value or not — so adding `shape` to this struct would have made
     every canvas.json written before shapes existed fail to decode. The store
     keeps a file it cannot read rather than overwriting it, which is the right
     behavior and would still have looked, to somebody who had just drawn a
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
        image = try c.decodeIfPresent(String.self, forKey: .image)
        blockId = try c.decodeIfPresent(String.self, forKey: .blockId)
        hAlign = try c.decodeIfPresent(TextAlign.self, forKey: .hAlign) ?? .center
        vAlign = try c.decodeIfPresent(TextVAlign.self, forKey: .vAlign) ?? .middle
        textColor = try c.decodeIfPresent(String.self, forKey: .textColor)
        fill = try c.decodeIfPresent(String.self, forKey: .fill)
        stroke = try c.decodeIfPresent(String.self, forKey: .stroke)
        strokeWidth = try c.decodeIfPresent(CGFloat.self, forKey: .strokeWidth) ?? 1.5
        strokeStyle = try c.decodeIfPresent(LineStyle.self, forKey: .strokeStyle) ?? .solid
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
 items' centers. Storing where the handle *is* would be simpler and wrong: move
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
    var color: String?
    var width: CGFloat = 1.5
    var style: LineStyle = .solid

    var bend: CGSize {
        get { CGSize(width: bendX, height: bendY) }
        set { bendX = newValue.width; bendY = newValue.height }
    }

    init(id: UUID, from: UUID, to: UUID) {
        self.id = id
        self.from = from
        self.to = to
    }

    /// By hand, for the same reason `CanvasItem` is: the synthesized decoder
    /// demands every non-optional key whether or not it has a default, so a
    /// field added here would make every canvas written before it unreadable.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        from = try c.decode(UUID.self, forKey: .from)
        to = try c.decode(UUID.self, forKey: .to)
        bendX = try c.decodeIfPresent(CGFloat.self, forKey: .bendX) ?? 0
        bendY = try c.decodeIfPresent(CGFloat.self, forKey: .bendY) ?? 0
        color = try c.decodeIfPresent(String.self, forKey: .color)
        width = try c.decodeIfPresent(CGFloat.self, forKey: .width) ?? 1.5
        style = try c.decodeIfPresent(LineStyle.self, forKey: .style) ?? .solid
    }
}

/**
 What is selected. One value, because it can only ever be one of these.
 */
enum CanvasSelection: Equatable {
    case none
    case items(Set<UUID>)
    case link(UUID)
    case region(UUID)
}

/**
 A group of things, drawn as a box around them.

 **It has no rectangle.** The box is worked out from what is inside it, every
 time it is drawn, and that single decision is most of the feature: moving
 something within a region expands the region because the region *is* the extent
 of its members, not because anything watches for the move and grows a stored
 box. A stored box would need maintaining on every drag, every resize, every
 delete, and would be wrong for the one frame nobody tested.

 What it does own is what it is called and how it is drawn, because those are
 decisions somebody made rather than consequences of where things are.
 */
struct CanvasRegion: Identifiable, Equatable, Codable {
    let id: UUID
    var members: [UUID]
    var title: String = ""

    /// Across only. A region's name sits above the box on one line, so there is
    /// no "down" for it to be aligned in — offering one would be a control with
    /// nowhere to put the answer.
    var hAlign: TextAlign = .leading
    var textColor: String?
    var fill: String?
    var stroke: String?
    var strokeWidth: CGFloat = 1.5
    var strokeStyle: LineStyle = .dashed

    /// How far the box stands off the things inside it.
    static let padding: CGFloat = 18
    /// The band above it the name is written in.
    static let titleHeight: CGFloat = 18

    init(id: UUID, members: [UUID]) {
        self.id = id
        self.members = members
    }

    /// By hand, like the rest of this file, so a field added later does not make
    /// every canvas written before it unreadable.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        members = try c.decode([UUID].self, forKey: .members)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        hAlign = try c.decodeIfPresent(TextAlign.self, forKey: .hAlign) ?? .leading
        textColor = try c.decodeIfPresent(String.self, forKey: .textColor)
        fill = try c.decodeIfPresent(String.self, forKey: .fill)
        stroke = try c.decodeIfPresent(String.self, forKey: .stroke)
        strokeWidth = try c.decodeIfPresent(CGFloat.self, forKey: .strokeWidth) ?? 1.5
        strokeStyle = try c.decodeIfPresent(LineStyle.self, forKey: .strokeStyle) ?? .dashed
    }

    /// The box, given where its members are now.
    ///
    /// Nothing when it holds nothing that still exists — a region whose contents
    /// have all been deleted is not an empty box floating on the canvas, it is a
    /// region that is over.
    static func box(of members: [CGRect]) -> CGRect? {
        guard var box = members.first else { return nil }
        for r in members.dropFirst() { box = box.union(r) }
        // Only the padding. The name is written above this, outside it, so the
        // box is the extent of the things and a margin — nothing else.
        return box.insetBy(dx: -padding, dy: -padding)
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
    var regions: [CanvasRegion] = []

    init(items: [CanvasItem] = [], links: [CanvasLink] = [], regions: [CanvasRegion] = []) {
        self.items = items
        self.links = links
        self.regions = regions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([CanvasItem].self, forKey: .items) ?? []
        links = try c.decodeIfPresent([CanvasLink].self, forKey: .links) ?? []
        regions = try c.decodeIfPresent([CanvasRegion].self, forKey: .regions) ?? []
    }
}

/**
 A canvas in one file.

 The working canvas is a JSON document beside a directory of pictures, which is
 right for something written every few seconds and read by a person. A canvas
 somebody saves and sends somewhere is a different job: it has to be one thing,
 or half of it arrives.

 So the pictures come inside, as base64, which is exactly the trade refused for
 the working file and exactly right here. That file is written on every drag and
 nobody would ever read a megabyte of it; this one is written when somebody asks
 and its whole purpose is to survive being copied.
 */
struct CanvasExport: Codable {
    var document: CanvasDocument
    /// By the name the document refers to them by. `Data` is base64 in JSON,
    /// which is what makes this one file rather than a folder.
    var images: [String: Data] = [:]
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
    /**
     Keep these bytes, and answer the name to ask for them by.

     Still a store that could be implemented over a piece of paper: this is
     "put this photograph in the drawer and tell me where". Nil when it could
     not be kept, which the caller has to handle rather than assume — a picture
     silently not saved is a canvas that comes back with a hole in it.
     */
    func keep(image: Data, extension ext: String) -> String?
    /// The bytes back, or nothing if they are no longer there.
    func image(named: String) -> Data?
    /// Throw a picture away. Only ever called for one nothing refers to.
    func forget(image name: String)
    /// Put a copy somewhere out of the way, under a name of its own.
    ///
    /// Used once: immediately before a load replaces everything. Loading is the
    /// only thing here that destroys a canvas without asking, and the file panel
    /// is a poor confirmation — somebody choosing a file has said which file,
    /// not that the one they have is finished with.
    func archive(_ document: CanvasDocument, as name: String)
}

/**
 The canvas, for as long as the app is running. For tests, and for a canvas
 nobody wants kept.
 */
final class MemoryCanvasStore: CanvasStore {
    private var document = CanvasDocument()
    private var images: [String: Data] = [:]
    func load() -> CanvasDocument { document }
    func save(_ document: CanvasDocument) { self.document = document }
    func keep(image: Data, extension ext: String) -> String? {
        let name = "\(UUID().uuidString).\(ext)"
        images[name] = image
        return name
    }
    func image(named: String) -> Data? { images[named] }
    func forget(image name: String) { images[name] = nil }
    func archive(_ document: CanvasDocument, as name: String) {}
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

 **Written by rename.** The bytes go to a neighboring file and that file is
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

    /**
     Pictures live beside the canvas, one file each.

     A directory rather than bytes in the JSON, so the canvas file stays
     something a person can open and read — a screenshot base64'd into it would
     be a megabyte on one line, technically still readable and never read again.
     It also means a picture can be looked at, replaced or thrown away with the
     Finder, which is the same argument the config file won.

     Named by a fresh id rather than by the file it came from. Two screenshots
     are both called Screenshot, and a store that let the second quietly replace
     the first would take a picture off a canvas that was never touched.
     */
    private var imageDirectory: URL {
        url.deletingLastPathComponent().appendingPathComponent("canvas-images", isDirectory: true)
    }

    func keep(image: Data, extension ext: String) -> String? {
        let name = "\(UUID().uuidString).\(ext)"
        do {
            try FileManager.default.createDirectory(at: imageDirectory, withIntermediateDirectories: true)
            try image.write(to: imageDirectory.appendingPathComponent(name), options: .atomic)
            return name
        } catch {
            NSLog("talaria: could not keep a canvas image (\(error))")
            return nil
        }
    }

    func image(named: String) -> Data? {
        guard safe(named) else { return nil }
        return try? Data(contentsOf: imageDirectory.appendingPathComponent(named))
    }

    func forget(image name: String) {
        guard safe(name) else { return }
        try? FileManager.default.removeItem(at: imageDirectory.appendingPathComponent(name))
    }

    func archive(_ document: CanvasDocument, as name: String) {
        let to = url.deletingLastPathComponent().appendingPathComponent(name)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? encoder.encode(document).write(to: to, options: .atomic)
    }

    /// A name from the document, so it must not be able to address anything
    /// outside the directory it belongs to. A file written by hand — or a canvas
    /// copied from somewhere else — is not automatically trustworthy just
    /// because it is on this machine. It matters more for deleting than for
    /// reading: the worst a bad name could do above is fail.
    private func safe(_ name: String) -> Bool {
        !name.contains("/") && !name.contains("..") && !name.isEmpty
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
    @Published private(set) var regions: [CanvasRegion] = []
    /// Under the pointer. Highlighted, and nothing more.
    @Published var hovered: UUID?
    /// Clicked. Gets the resize handles.
    /**
     What is selected, as one value.

     Four shapes rather than four fields. "Never more than one kind at once" was
     an invariant kept by every caller remembering to clear the others, and that
     had a bug in it the first time it was written — so it is a single value now
     and the compiler keeps it.

     Items are a *set*, because a marquee selects several and one is just a set
     of one. Everything that used to ask "is this the selected item" asks whether
     the set contains it, and nothing needs to know which case it came from.
     */
    @Published private(set) var selection: CanvasSelection = .none

    /// The one selected item, when there is exactly one. What the inspector and
    /// the resize grips are about — neither means anything for six at once.
    var selected: UUID? {
        if case .items(let ids) = selection, ids.count == 1 { return ids.first }
        return nil
    }

    var selectedItems: Set<UUID> {
        if case .items(let ids) = selection { return ids }
        return []
    }

    var selectedLink: UUID? {
        if case .link(let id) = selection { return id }
        return nil
    }

    var selectedRegion: UUID? {
        if case .region(let id) = selection { return id }
        return nil
    }
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
        // A region keeps only the members that are still here, and a region left
        // holding nothing is over rather than empty.
        regions = document.regions
            .map { var r = $0; r.members = r.members.filter(present.contains); return r }
            .filter { !$0.members.isEmpty }
        // Either end may be a region, so both kinds count as still existing.
        let anchors = present.union(regions.map(\.id))
        links = document.links.filter { anchors.contains($0.from) && anchors.contains($0.to) }
        // A canvas whose labels are too short for their own text — because the
        // font changed, or an older build measured differently — is grown into
        // range on the way in. Never shrunk: a box somebody made roomy on
        // purpose is not a mistake to correct.
        for item in items where item.shape == .plain {
            fitToText(item.id, text: item.text)
        }
    }

    /// Kept in step with the collection behind the canvas, when there is one.
    /// Nil until `back(with:)` hands one over — the canvas works exactly as it
    /// always has without it.
    var sync: CanvasSync?

    private func persist() {
        let document = CanvasDocument(items: items, links: links, regions: regions)
        // The file first, always. It is the working document and the only thing
        // a drag is allowed to wait on; the sync is told afterwards and answers
        // on its own time.
        store.save(document)
        sync?.changed(document)
    }

    /**
     Everything, as the collection now has it.

     Replaces rather than merges, and that is not laziness — a merge needs a
     rule for every field of every node, and the rule that matters here is
     already enforced one layer down: a push carries the version each member was
     read at, so an edit made while somebody else was editing is refused at the
     write rather than reconciled at the read. What arrives here has already
     won.
     */
    func adopt(_ document: CanvasDocument) {
        items = document.items
        links = document.links
        regions = document.regions
        // The file, but not the sync: this came *from* the far end, and telling
        // the sync about it would send it straight back.
        store.save(document)
    }

    func item(_ id: UUID) -> CanvasItem? { items.first { $0.id == id } }

    /**
     One selection, whatever it is on.

     Both setters go through here because "never both at once" was true only
     while every caller remembered to clear the other one, and one of them did
     not: clicking a line after an item cleared the item because that path
     happened to reset it first, and clicking an item after a line left the line
     lit because that path did not. An invariant kept by habit is an invariant
     with a bug in it somewhere.
     */
    func select(item id: UUID?) {
        selection = id.map { .items([$0]) } ?? .none
    }

    func select(items ids: Set<UUID>) {
        selection = ids.isEmpty ? .none : .items(ids)
    }

    func select(link id: UUID?) {
        selection = id.map { .link($0) } ?? .none
    }

    func select(region id: UUID?) {
        selection = id.map { .region($0) } ?? .none
    }

    func clearSelection() { selection = .none }

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

    /**
     Change how one item looks.

     One entry point for every style change, so each of them is saved the same
     way and none of them is the one somebody forgot to persist. The closure
     shape means the inspector can bind straight to a field without the model
     needing a setter for each.
     */
    func restyle(_ id: UUID, _ change: (inout CanvasItem) -> Void) {
        guard let at = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[at])
        persist()
    }

    /// The box a region occupies right now, or nothing if it holds nothing.
    func box(of region: CanvasRegion) -> CGRect? {
        CanvasRegion.box(of: region.members.compactMap { item($0)?.rect })
    }

    /**
     Where a thing is, whatever kind of thing it is.

     A connector's two ends are ids and nothing else. Making a region joinable
     therefore needed one function rather than a second kind of link: everything
     that draws a line asks where its ends are, and this is the only place that
     has to know a region is not an item.
     */
    func rect(of id: UUID) -> CGRect? {
        if let item = item(id) { return item.rect }
        if let region = regions.first(where: { $0.id == id }) { return box(of: region) }
        return nil
    }

    /**
     Which region a point is in. Innermost first, so a region inside a region is
     reachable.

     `excluding` is not a convenience. A region being dragged travels under the
     pointer, so it always contains it — and "innermost" then means the dragged
     one whenever it is the smaller of the two. Dropping a small region onto a
     big one therefore found only itself and connected nothing, while the same
     two the other way round worked perfectly. One direction working and the
     other not is what that looks like from outside, and it is not obviously a
     size question until you go looking.
     */
    func region(at point: CGPoint, excluding: UUID? = nil) -> CanvasRegion? {
        regions
            .filter { $0.id != excluding }
            .compactMap { r in box(of: r).map { (r, $0) } }
            .filter { $0.1.contains(point) }
            .min { $0.1.width * $0.1.height < $1.1.width * $1.1.height }?.0
    }

    /**
     Put a box around these.

     Nothing clever about which things: a region holds exactly what was selected
     when it was made. Growing to contain something dragged into it happens on
     its own, because the box is the extent of its members and moving a member
     changes that extent — no watching, no maintenance, nothing to be wrong for
     one frame.
     */
    @discardableResult
    func addRegion(around ids: Set<UUID>) -> UUID? {
        let held = items.filter { ids.contains($0.id) }.map(\.id)
        guard !held.isEmpty else { return nil }
        let region = CanvasRegion(id: UUID(), members: held)
        regions.append(region)
        selection = .region(region.id)
        persist()
        return region.id
    }

    func restyleRegion(_ id: UUID, _ change: (inout CanvasRegion) -> Void) {
        guard let at = regions.firstIndex(where: { $0.id == id }) else { return }
        change(&regions[at])
        persist()
    }

    /// The box goes; what was in it stays. A region is a way of talking about
    /// things, and removing the way of talking about them is not removing them.
    func removeRegion(_ id: UUID) {
        regions.removeAll { $0.id == id }
        // Lines drawn to the box go with the box. What was inside it stays, and
        // so does anything joined to those things directly.
        links.removeAll { $0.from == id || $0.to == id }
        if selectedRegion == id { clearSelection() }
        persist()
    }

    /// Put something in a box it was dropped into. Already in it is not an
    /// error — it is a card moved about inside its own region, which is most of
    /// the moves anybody makes once a region exists.
    func join(region id: UUID, item: UUID) {
        guard let at = regions.firstIndex(where: { $0.id == id }) else { return }
        guard !regions[at].members.contains(item) else { return }
        regions[at].members.append(item)
        persist()
    }

    /// In, or out. The only way to take one thing out of a region without
    /// deleting it, which nothing else offers.
    func toggle(region id: UUID, item: UUID) {
        guard let at = regions.firstIndex(where: { $0.id == id }) else { return }
        if let member = regions[at].members.firstIndex(of: item) {
            // Never down to nothing. A region holding no members has no box and
            // would vanish mid-gesture, taking the mode with it — so the last
            // one stays, and the way to be rid of a region is the button that
            // says so.
            guard regions[at].members.count > 1 else { return }
            regions[at].members.remove(at: member)
        } else {
            regions[at].members.append(item)
        }
        persist()
    }

    func isMember(_ item: UUID, of region: UUID) -> Bool {
        regions.first { $0.id == region }?.members.contains(item) ?? false
    }

    /// The only thing left in a region, which is why it cannot be taken out.
    func isLastMember(_ item: UUID, of region: UUID) -> Bool {
        regions.first { $0.id == region }?.members == [item]
    }

    /// Everything in a region, moved together.
    func moveRegion(_ id: UUID, by delta: CGSize) {
        guard let region = regions.first(where: { $0.id == id }) else { return }
        for member in region.members {
            guard let at = items.firstIndex(where: { $0.id == member }) else { continue }
            items[at].x += delta.width
            items[at].y += delta.height
        }
    }

    /// Several at once, for a marquee drag.
    func moveItems(_ ids: Set<UUID>, by delta: CGSize) {
        for id in ids {
            guard let at = items.firstIndex(where: { $0.id == id }) else { continue }
            items[at].x += delta.width
            items[at].y += delta.height
        }
    }

    /**
     The whole canvas as one value, pictures included.

     Anything whose bytes have gone missing is left out rather than exported as
     an empty entry — a saved file with a name in it and nothing behind the name
     is a file that loads to a hole.
     */
    func export() -> CanvasExport {
        var images: [String: Data] = [:]
        for item in items {
            guard let name = item.image, let data = store.image(named: name) else { continue }
            images[name] = data
        }
        return CanvasExport(document: CanvasDocument(items: items, links: links, regions: regions),
                            images: images)
    }

    /**
     Replace everything with what was in a file.

     Pictures are written back under fresh names and the items are pointed at
     them, rather than keeping the names they arrived with. Two canvases saved on
     two machines can hold the same name for two different pictures, and a load
     that trusted the name would show one of them in both places.

     The canvas being replaced is put aside first. Loading is the only thing here
     that destroys a canvas, and a file panel is a poor confirmation: choosing a
     file says which file, not that the one you have is finished with. There is a
     question in front of this as well — this is what is left if the answer to it
     was wrong.
     */
    func load(_ export: CanvasExport) {
        store.archive(CanvasDocument(items: items, links: links, regions: regions),
                      as: "canvas-replaced.json")
        for item in items { if let name = item.image { store.forget(image: name) } }

        var renamed: [String: String] = [:]
        for (name, data) in export.images {
            let ext = (name as NSString).pathExtension
            if let fresh = store.keep(image: data, extension: ext.isEmpty ? "png" : ext) {
                renamed[name] = fresh
            }
        }
        items = export.document.items.map { item in
            var copy = item
            if let old = item.image { copy.image = renamed[old] }
            return copy
        }
        // A picture whose bytes did not come with the file leaves an item that
        // would draw as an empty box. Dropped, rather than kept as a hole.
        items.removeAll { $0.image != nil && $0.image.flatMap(store.image(named:)) == nil }

        let present = Set(items.map(\.id))
        regions = export.document.regions
            .map { var r = $0; r.members = r.members.filter(present.contains); return r }
            .filter { !$0.members.isEmpty }
        let anchors = present.union(regions.map(\.id))
        links = export.document.links.filter { anchors.contains($0.from) && anchors.contains($0.to) }

        editing = nil
        draft = ""
        clearSelection()
        persist()
    }

    /// Everything, gone. Pictures too — a canvas-images directory full of files
    /// nothing refers to is rubbish left behind by a thing that said it cleared.
    func clearAll() {
        for item in items { if let name = item.image { store.forget(image: name) } }
        items = []
        links = []
        regions = []
        editing = nil
        draft = ""
        clearSelection()
        persist()
    }

    func deleteItems(_ ids: Set<UUID>) {
        items.removeAll { ids.contains($0.id) }
        links.removeAll { ids.contains($0.from) || ids.contains($0.to) }
        let emptied = regions.filter { $0.members.allSatisfy(ids.contains) }.map(\.id)
        regions = regions
            .map { var r = $0; r.members = r.members.filter { !ids.contains($0) }; return r }
            .filter { !$0.members.isEmpty }
        links.removeAll { emptied.contains($0.from) || emptied.contains($0.to) }
        clearSelection()
        persist()
    }

    /// Remember which block a node became. Called once, after the composer
    /// says what it made.
    func attach(_ item: UUID, to block: String) {
        guard let at = items.firstIndex(where: { $0.id == item }) else { return }
        items[at].blockId = block
        persist()
    }

    func restyleLink(_ id: UUID, _ change: (inout CanvasLink) -> Void) {
        guard let at = links.firstIndex(where: { $0.id == id }) else { return }
        change(&links[at])
        persist()
    }

    /**
     Turn one thing into another shape.

     Not just a field: a bare label is the size of its words and a shape is the
     size somebody dragged, so becoming one from the other has to bring a size
     with it. Growing into a shape takes the default; shrinking back to a label
     takes the measurement, because a 130x90 box round the word "yes" is not a
     label, it is a label sitting in the corner of nothing.
     */
    func setShape(_ id: UUID, _ shape: CanvasShape) {
        guard let at = items.firstIndex(where: { $0.id == id }), items[at].shape != shape else { return }
        let was = items[at].shape
        items[at].shape = shape
        if was == .plain, shape != .plain {
            let size = shape.defaultSize
            items[at].w = max(items[at].w, size.width)
            items[at].h = max(items[at].h, size.height)
        } else if shape == .plain {
            let size = CanvasItem.measure(items[at].text)
            items[at].w = size.width
            items[at].h = size.height
        }
        persist()
    }

    func bend(_ id: UUID, by offset: CGSize) {
        guard let at = links.firstIndex(where: { $0.id == id }) else { return }
        links[at].bend = offset
    }

    func removeLink(_ id: UUID) {
        links.removeAll { $0.id == id }
        if selectedLink == id { clearSelection() }
        persist()
    }

    /// Default size for a new text item: wide enough for a few words, tall
    /// enough for one line at twelve point. It grows when somebody resizes it,
    /// and never on its own — a box that resized itself while being typed into
    /// would move the words out from under the cursor.
    static let newItemSize = CGSize(width: 180, height: 24)

    /**
     Drop a new text item, centered on where the tool was let go, and start
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
        clearSelection()
        draft = ""
        editing = item.id
        // Not persisted yet. An item with no words in it is a gesture in
        // progress, not a thing somebody made.
    }

    /// The widest or tallest a picture arrives at. Big enough to see, small
    /// enough that a screenshot of a whole display does not become the canvas.
    static let imageLongEdge: CGFloat = 380

    /**
     Put a picture on the canvas, at its own proportions.

     Centred on the point given, which for a menu is the middle of what somebody
     is looking at. A menu click carries no position — that is the argument for
     dragging the other tools — so the honest answer is the middle of the view
     rather than a corner or the canvas origin, both of which can be a long way
     from anywhere anybody can see.

     Answers whether it worked. A picture that could not be written is a hole in
     the canvas, and the surface has to be able to say so rather than draw an
     empty box.
     */
    @discardableResult
    func addImage(_ data: Data, extension ext: String, pixelSize: CGSize, at point: CGPoint) -> Bool {
        guard let name = store.keep(image: data, extension: ext) else { return false }
        let longest = max(pixelSize.width, pixelSize.height, 1)
        let scale = min(1, Self.imageLongEdge / longest)
        let size = CGSize(width: max(pixelSize.width * scale, 24).rounded(),
                          height: max(pixelSize.height * scale, 24).rounded())
        items.append(CanvasItem(
            id: UUID(),
            x: point.x - size.width / 2,
            y: point.y - size.height / 2,
            w: size.width, h: size.height,
            text: "", shape: .plain, image: name
        ))
        clearSelection()
        persist()
        return true
    }

    /// The bytes for an item's picture, if it has one and they are still there.
    func imageData(for item: CanvasItem) -> Data? {
        item.image.flatMap { store.image(named: $0) }
    }

    /// Start editing something already there.
    func beginEditing(_ id: UUID) {
        guard let item = items.first(where: { $0.id == id }), item.image == nil else { return }
        clearSelection()
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
     Keep a label tall enough for what it says.

     Grows and never shrinks. The size of the text is a floor rather than the
     answer: a box may be bigger than its words — somebody may want room round a
     label, or be lining it up with something beside it — and the only thing it
     may not be is too small to show them.

     Height only. The width is whatever somebody dragged it to, and taking that
     back because a word was deleted would undo a decision they made on purpose.
     Called as the words are typed rather than only when they are finished,
     because a caret disappearing off the bottom of its own box mid-sentence is
     the thing this exists to stop.
     */
    func fitToText(_ id: UUID, text: String) {
        guard let at = items.firstIndex(where: { $0.id == id }), items[at].shape == .plain else { return }
        // A box that has been made smaller than its own words is scrolling on
        // purpose, and growing it back would undo the resize on the next
        // keystroke. Only a box that is currently keeping up keeps up.
        let keepingUp = items[at].h >= CanvasItem.leastHeight(of: items[at].text, at: items[at].w)
        // Sideways first, up to the point where a line stops being a line. Past
        // that it wraps and the box grows downward instead — a label eight
        // hundred points wide is a paragraph pretending to be one, and it also
        // runs off whatever anybody is looking at.
        let natural = CanvasItem.measure(text).width
        items[at].w = max(items[at].w, min(natural, CanvasItem.widestAuto))
        // Then down, at whatever width it ended up with. A line break makes this
        // the only thing that moves, which is what a line break should do.
        if keepingUp {
            items[at].h = max(items[at].h, CanvasItem.leastHeight(of: text, at: items[at].w))
        }
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
        // No floor from the text any more. A box may be made smaller than what it
        // says, and what it says then scrolls — which is the only way to have a
        // long note on a canvas without the note being the size of the note.
        // The general minimum still applies, so nothing can be shrunk to a size
        // it cannot be grabbed by again.
        items[at].rect = box
    }

    /// A drag or a resize has finished. Separate from the moving itself so that
    /// a store is written once per gesture rather than once per frame.
    func settled() { persist() }

    func delete(_ id: UUID) {
        items.removeAll { $0.id == id }
        // A line to something that is gone is a line to nowhere.
        links.removeAll { $0.from == id || $0.to == id }
        let emptied = regions.filter { $0.members == [id] }.map(\.id)
        regions = regions
            .map { var r = $0; r.members = r.members.filter { $0 != id }; return r }
            .filter { !$0.members.isEmpty }
        links.removeAll { emptied.contains($0.from) || emptied.contains($0.to) }
        if selectedItems.contains(id) { select(items: selectedItems.subtracting([id])) }
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
 for. With no bend that point is halfway between the two centers, which gives the
 sides that face each other. Pull the handle up and over, and both ends
 re-anchor to their top edges on the way — which is the behavior asked for, and
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
    static func sideCenters(_ r: CGRect) -> [CGPoint] {
        [
            CGPoint(x: r.midX, y: r.minY),
            CGPoint(x: r.midX, y: r.maxY),
            CGPoint(x: r.minX, y: r.midY),
            CGPoint(x: r.maxX, y: r.midY),
        ]
    }

    /**
     Whichever side center is nearest.

     Plain distance between the four centers and the point the line is heading
     for — the side is chosen by where its middle is, and nothing else about the
     side is considered.

     Worth knowing what this does at the edges, because it is not the rule most
     canvas tools use. On a box much wider than it is tall, the north and south
     centers sit close together near the middle and the east and west ones are
     far out to the sides, so a handle pulled a long way up and moderately to
     the right can still be nearer the east center than the north one — and the
     line leaves sideways out of a curve heading upwards. That is the rule doing
     exactly what it says; it is only surprising if you expected the line to
     follow the direction of travel rather than the geometry.
     */
    private static func nearestSide(of r: CGRect, to p: CGPoint) -> CGPoint {
        sideCenters(r).min { a, b in
            hypot(a.x - p.x, a.y - p.y) < hypot(b.x - p.x, b.y - p.y)
        } ?? CGPoint(x: r.midX, y: r.midY)
    }

    static func of(from: CGRect, to: CGRect, bend: CGSize) -> LinkGeometry {
        // Which sides face each other is a question about the two boxes, and
        // the midpoint of their centers is the answer to it — aimed at from
        // both ends, so each picks the side pointing at the other.
        let aim = CGPoint(
            x: (from.midX + to.midX) / 2 + bend.width,
            y: (from.midY + to.midY) / 2 + bend.height
        )
        let a = nearestSide(of: from, to: aim)
        let b = nearestSide(of: to, to: aim)

        // Where the curve goes is a question about the two *anchors*, which is
        // not the same question and was being answered with the first one's
        // maths.
        //
        // The midpoint of two centers is the midpoint of two anchors only when
        // the boxes are the same size and facing. A region is not: it is the
        // size of everything inside it and a node is a node, so the two
        // midpoints sat a hundred points apart and the control point solved
        // from the wrong one landed *past* the far anchor — inside the region.
        // The line bulged in, came back out, and touched the border from the
        // wrong side. Which is exactly what it looked like.
        //
        // Solved from the anchors, zero bend puts the control on the segment
        // between them and a straight line is straight, whatever the two things
        // are the size of.
        let handle = CGPoint(x: (a.x + b.x) / 2 + bend.width,
                             y: (a.y + b.y) / 2 + bend.height)
        let control = CGPoint(x: (a.x + b.x) / 2 + 2 * bend.width,
                              y: (a.y + b.y) / 2 + 2 * bend.height)
        return LinkGeometry(start: a, end: b, control: control, handle: handle)
    }

    func point(at t: CGFloat) -> CGPoint {
        let u = 1 - t
        return CGPoint(
            x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
            y: u * u * start.y + 2 * u * t * control.y + t * t * end.y
        )
    }

    /// The direction the line is traveling as it arrives, for the arrowhead.
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

// MARK: - Chrome

/**
 A thing that is clicked rather than drawn on.

 The pointer becomes a finger over it, and the canvas is told so it can stop
 asserting its own. One modifier, worn by every control, so a new one gets the
 behavior by being a control rather than by somebody remembering.
 */
private struct Chrome: ViewModifier {
    @Binding var depth: Int
    func body(content: Content) -> some View {
        content.onHover { inside in
            // A count and not a flag, because chrome sits on chrome: the shape
            // menu opens over the strip, so leaving the menu is not leaving the
            // controls. A flag would have gone false there and put the open hand
            // back over a row of buttons.
            //
            // Clamped, because an enter without its matching exit is possible —
            // a delete button disappears the moment it is used, and the pointer
            // never leaves it. The clamp keeps that from going negative and the
            // reset below keeps it from sticking high.
            depth = max(0, depth + (inside ? 1 : -1))
        }
    }
}

private extension View {
    func chrome(_ depth: Binding<Int>) -> some View { modifier(Chrome(depth: depth)) }
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
    case image
    case select

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .text: return "textformat"
        case .image: return "photo"
        case .select: return "rectangle.dashed"
        }
    }

    var name: String {
        switch self {
        case .text: return "Text"
        case .image: return "Image"
        case .select: return "Select"
        }
    }

    var hint: String {
        switch self {
        case .text: return "Drag onto the canvas to write"
        case .image: return "Add a picture from the clipboard or a file"
        case .select: return "Click, then drag a box around things"
        }
    }

    /// Whether it has a menu behind it, which is what the corner marker says.
    ///
    /// A picture no longer does. It used to, on the reasoning that a menu click
    /// has no position — which was true, and the wrong thing to fix. The fix is
    /// to give it a position: drag it like everything else, and ask where the
    /// picture comes from once it has landed somewhere.
    var hasMenu: Bool { self == .text }

    /// Everything drags except the selector, which is a mode rather than a
    /// thing: there is nothing to carry onto the canvas, and the drag it cares
    /// about is the one that happens afterwards, on the canvas itself.
    var draggable: Bool { self != .select }

    /// Whether clicking it turns something on until it is clicked again.
    var isMode: Bool { self == .select }
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
/**
 The Hermes mark, from the bundle.

 The same artwork as the menu bar's, which is not a shortcut: the wing *is* the
 Hermes Notes mark now — the web app was changed to it — and Talaria wears it
 because Talaria is a way into Hermes. One file, one mark, no second copy to
 fall out of step.

 A template image, so it takes the color it is given rather than arriving black
 on a colored button.
 */
struct WingMark: View {
    var size: CGFloat = 11

    private static let image: NSImage? = {
        guard let found = NSImage(contentsOfFile: Bundle.main.bundlePath + "/Contents/Resources/MenuBar.pdf")
        else { return nil }
        found.isTemplate = true
        return found
    }()

    var body: some View {
        if let image = Self.image {
            Image(nsImage: image)
                .resizable()
                .renderingMode(.template)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else {
            // No bundle resource — a checkout whose icon step has not run.
            Image(systemName: "arrow.up.forward.square")
                .font(.system(size: size * 0.8, weight: .bold))
        }
    }
}

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

/**
 Where a picture comes from.

 Two, because they are the two places one ever is: just copied, or already
 saved. Anything else — a URL, a drag from a browser — is a different gesture
 and can be its own entry when somebody wants it.
 */
enum ImageSource: String, CaseIterable, Identifiable {
    case clipboard
    case file

    var id: String { rawValue }

    var name: String {
        switch self {
        case .clipboard: return "From clipboard"
        case .file: return "From file"
        }
    }

    var symbol: String {
        switch self {
        case .clipboard: return "doc.on.clipboard"
        case .file: return "folder"
        }
    }
}

/// A picture, and what it takes to draw it.
struct PickedImage {
    let data: Data
    let ext: String
    let pixelSize: CGSize
}

enum ImagePicker {
    /**
     Whatever is on the clipboard, if it is a picture.

     PNG first and TIFF second. The clipboard usually carries the same picture
     several ways at once, and a screenshot's TIFF is several times the size of
     its PNG for the same pixels — asking for PNG first is the difference
     between a 300KB file and a 4MB one, on a canvas people will fill with
     screenshots.
     */
    static func fromClipboard() -> PickedImage? {
        let board = NSPasteboard.general
        if let data = board.data(forType: .png), let rep = NSImage(data: data) {
            return PickedImage(data: data, ext: "png", pixelSize: pixels(of: rep))
        }
        if let data = board.data(forType: .tiff), let rep = NSImage(data: data) {
            // Re-encoded rather than kept as TIFF, for the size reason above.
            if let png = png(from: rep) {
                return PickedImage(data: png, ext: "png", pixelSize: pixels(of: rep))
            }
        }
        // A file copied in the Finder arrives as a promise of a URL, not bytes.
        if let urls = board.readObjects(forClasses: [NSURL.self]) as? [URL],
           let url = urls.first,
           let data = try? Data(contentsOf: url),
           let rep = NSImage(data: data) {
            return PickedImage(data: data, ext: url.pathExtension.isEmpty ? "png" : url.pathExtension.lowercased(),
                               pixelSize: pixels(of: rep))
        }
        return nil
    }

    /// A picture chosen from disk. Blocks, because a file panel is a
    /// conversation and there is nothing to do until it is over.
    static func fromFile() -> PickedImage? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.prompt = "Add"
        guard panel.runModal() == .OK, let url = panel.url,
              let data = try? Data(contentsOf: url), let rep = NSImage(data: data) else { return nil }
        return PickedImage(data: data,
                           ext: url.pathExtension.isEmpty ? "png" : url.pathExtension.lowercased(),
                           pixelSize: pixels(of: rep))
    }

    /// The real pixel dimensions, not the point size.
    ///
    /// `NSImage.size` is in points and a Retina screenshot reports half its
    /// pixels, so a picture placed by it arrives at half the size it should be
    /// and looks soft when it is scaled back up.
    private static func pixels(of image: NSImage) -> CGSize {
        if let rep = image.representations.first {
            return CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)
        }
        return image.size
    }

    private static func png(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}

/// Saving, and the one that replaces everything.
enum CanvasFile: String, CaseIterable, Identifiable {
    case save
    case load
    case png
    case pdf

    var id: String { rawValue }

    var name: String {
        switch self {
        case .save: return "Save…"
        case .load: return "Load…"
        case .png: return "Export PNG…"
        case .pdf: return "Export PDF…"
        }
    }

    var symbol: String {
        switch self {
        case .save: return "square.and.arrow.down"
        case .load: return "square.and.arrow.up"
        case .png: return "photo"
        case .pdf: return "doc.richtext"
        }
    }

    /// Whether it replaces the canvas, and therefore has to ask.
    var destroys: Bool { self == .load }
}

enum CanvasFiles {
    /// Where to write it. Nil when the panel was dismissed, which is a decision
    /// and not a failure.
    static func destination(_ kind: UTType, named: String) -> URL? {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [kind]
        panel.nameFieldStringValue = named
        panel.prompt = "Save"
        return panel.runModal() == .OK ? panel.url : nil
    }

    static func source() -> URL? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.json]
        panel.prompt = "Load"
        return panel.runModal() == .OK ? panel.url : nil
    }

    static func write(_ data: Data, to url: URL) -> String? {
        do {
            try data.write(to: url, options: .atomic)
            return nil
        } catch {
            return "That could not be written"
        }
    }

    static func write(_ export: CanvasExport, to url: URL) -> String? {
        do {
            let encoder = JSONEncoder()
            // Readable, like the working file. A canvas somebody sends to
            // somebody else is still a document, and a document that can be
            // opened in a text editor can be repaired in one.
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(export).write(to: url, options: .atomic)
            return nil
        } catch {
            return "That canvas could not be saved"
        }
    }

    /// The canvas, or why not. A tuple rather than `Result`, because the
    /// failure here is a sentence for a person rather than an error anything
    /// catches.
    static func read(_ url: URL) -> (canvas: CanvasExport?, trouble: String?) {
        guard let data = try? Data(contentsOf: url) else { return (nil, "That file could not be read") }
        if let export = try? JSONDecoder().decode(CanvasExport.self, from: data) {
            return (export, nil)
        }
        // A working canvas.json is a document rather than an export. Reading one
        // is obviously what somebody means by picking it, and refusing on a
        // technicality would be refusing the file this app writes itself.
        if let document = try? JSONDecoder().decode(CanvasDocument.self, from: data) {
            return (CanvasExport(document: document, images: [:]), nil)
        }
        return (nil, "That file is not a canvas")
    }
}

/// Save or load, offered beside the button.
private struct FileMenu: View {
    /// Which entry has been asked about but not confirmed.
    @Binding var confirming: CanvasFile?
    let pick: (CanvasFile) -> Void

    var body: some View {
        VStack(spacing: 2) {
            ForEach(CanvasFile.allCases) { entry in
                let asking = confirming == entry
                Button {
                    // Loading replaces everything, so it asks first — before the
                    // file panel, because the question is about losing what is
                    // here and not about which file. Saving takes nothing away
                    // and asks nothing.
                    if entry.destroys, !asking {
                        confirming = .load
                    } else {
                        confirming = nil
                        pick(entry)
                    }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: asking ? "exclamationmark.triangle.fill" : entry.symbol)
                            .font(.system(size: 12, weight: .medium))
                            .frame(width: 16)
                        Text(asking ? "Sure?" : entry.name).font(Theme.chrome(11))
                        Spacer(minLength: 0)
                    }
                    .frame(width: 116, height: 24)
                    .contentShape(Rectangle())
                    .foregroundStyle(asking ? Theme.danger : Color.primary.opacity(0.85))
                }
                .buttonStyle(.plain)
            }
            if confirming == .load {
                Text("Replaces this canvas")
                    .font(Theme.chrome(9))
                    .foregroundStyle(.secondary)
                    .frame(width: 116, alignment: .leading)
                    .padding(.bottom, 2)
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

/// The two places a picture comes from, offered beside the tool.
private struct ImageMenu: View {
    let pick: (ImageSource) -> Void

    var body: some View {
        VStack(spacing: 2) {
            ForEach(ImageSource.allCases) { source in
                Button { pick(source) } label: {
                    HStack(spacing: 7) {
                        Image(systemName: source.symbol)
                            .font(.system(size: 12, weight: .medium))
                            .frame(width: 16)
                        Text(source.name).font(Theme.chrome(11))
                        Spacer(minLength: 0)
                    }
                    .frame(width: 116, height: 24)
                    .contentShape(Rectangle())
                    .foregroundStyle(Color.primary.opacity(0.85))
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
    /// Which tool's menu is showing, if any. One at a time: two open menus
    /// beside each other is two lists competing for the same click.
    @Binding var openMenu: CanvasTool?
    /// A mode tool that is currently on.
    @Binding var armed: CanvasTool?
    @Binding var overChrome: Int
    /// How far through clearing the canvas somebody is: nothing, asked once,
    /// asked twice.
    @Binding var clearStep: Int
    @Binding var fileMenuOpen: Bool
    @Binding var confirmingFile: CanvasFile?
    let file: (CanvasFile) -> Void
    let clear: () -> Void
    let track: (CanvasTool, CGPoint) -> Void
    let drop: (CanvasTool, CGPoint) -> Void
    let pickImage: (ImageSource) -> Void

    private var clearLabel: some View {
        VStack(spacing: 2) {
            Image(systemName: clearStep == 0 ? "trash" : "exclamationmark.triangle.fill")
                .font(.system(size: 13, weight: .medium))
            Text(clearStep == 0 ? "Clear" : "Sure?")
                .font(Theme.chrome(9, weight: clearStep == 0 ? .medium : .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(width: 56, height: 38)
        .contentShape(Rectangle())
        .foregroundStyle(clearStep == 0 ? Color.secondary : Theme.danger)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(clearStep == 0 ? Color.clear : Theme.danger.opacity(0.12))
        )
    }

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
                    if tool.hasMenu { SubmenuCorner() }
                }
                .contentShape(Rectangle())
                .foregroundStyle(dragging == tool || openMenu == tool || armed == tool
                                 ? Theme.accent : Color.secondary)
                .background(
                    RoundedRectangle(cornerRadius: 7)
                        .fill(dragging == tool || openMenu == tool || armed == tool
                              ? Color.primary.opacity(0.08) : .clear)
                )
                .help(tool.hint)
                .gesture(
                    DragGesture(minimumDistance: 0, coordinateSpace: .global)
                        .onChanged { value in
                            guard tool.draggable else { return }
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
                            let moved = tool.draggable
                                && (abs(value.translation.width) > 4 || abs(value.translation.height) > 4)
                            if moved {
                                openMenu = nil
                                drop(tool, value.location)
                            } else if tool.isMode {
                                openMenu = nil
                                armed = armed == tool ? nil : tool
                            } else {
                                openMenu = openMenu == tool ? nil : tool
                            }
                        }
                )
            }
            /**
             Clear the whole canvas, having asked.

             One question, phrased the same as every other confirmation on this
             surface. It had two, on the reasoning that this destroys more than
             anything else here does — which is true, and not a reason to make
             the ceremony different from the ceremony everywhere else. A control
             that asks three times teaches people to click three times.

             At the bottom, below a divider, away from the tools. That is where
             the distance lives instead: it is not a tool and should not be
             reachable by the slip of the hand that reaches for one.
             */
            // Width given, not inherited. A `Divider` in a `VStack` takes all
            // the width there is, and this stack is in an overlay on the whole
            // canvas — so it stretched the strip from edge to edge and centered
            // every tool in it. The one greedy view in a column of fixed ones
            // decides the column.
            Divider().frame(width: 40).padding(.top, 2)

            // Above clear and under the divider: the two things that are about
            // the canvas as a whole rather than about anything on it.
            Button { fileMenuOpen.toggle() } label: {
                VStack(spacing: 2) {
                    Image(systemName: "tray.and.arrow.down")
                        .font(.system(size: 13, weight: .medium))
                    Text("File").font(Theme.chrome(9, weight: .medium))
                }
                .frame(width: 56, height: 38)
                .overlay(alignment: .bottomLeading) { SubmenuCorner() }
                .contentShape(Rectangle())
                .foregroundStyle(fileMenuOpen ? Theme.accent : Color.secondary)
                .background(
                    RoundedRectangle(cornerRadius: 7)
                        .fill(fileMenuOpen ? Color.primary.opacity(0.08) : Color.clear)
                )
            }
            .buttonStyle(.plain)
            .help("Save this canvas to a file, or load one")
            .overlay(alignment: .topTrailing) {
                if fileMenuOpen {
                    FileMenu(confirming: $confirmingFile) { entry in
                        fileMenuOpen = false
                        file(entry)
                    }
                    .fixedSize()
                    .chrome($overChrome)
                    .offset(x: -68)
                }
            }
            Button {
                if clearStep == 1 { clear(); clearStep = 0 } else { clearStep = 1 }
            } label: {
                clearLabel
            }
            .buttonStyle(.plain)
            .help(clearStep == 0 ? "Erase everything on this canvas" : "Click again — this cannot be undone")
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
        .chrome($overChrome)
        // To the left, because the strip is already against the right-hand edge
        // and a menu opening outward would open off the canvas.
        .overlay(alignment: .topTrailing) {
            switch openMenu {
            case .text:
                ShapeMenu(chosen: $shape) { openMenu = nil }
                    .fixedSize()
                    .chrome($overChrome)
                    .offset(x: -68)
                    .transition(.opacity.combined(with: .move(edge: .trailing)))
            case .select:
                // A mode has nothing behind it.
                EmptyView()
            case .image:
                ImageMenu { source in
                    openMenu = nil
                    pickImage(source)
                }
                .fixedSize()
                .chrome($overChrome)
                // Below the tool it belongs to, not beside the first one.
                .offset(x: -68, y: 46)
                .transition(.opacity.combined(with: .move(edge: .trailing)))
            case .none:
                EmptyView()
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
    /// While a region is taking members: whether this is one. Nothing at all
    /// when no region is asking, so the ordinary canvas is unmarked.
    let inRegion: Bool?
    /// The block this node stands for, when it stands for one.
    let badge: LinkedBadge?

    /**
     What a node shows when it is a Hermes block.

     An icon and, when the type says a thing can be finished, whether it is —
     and that second one is a control rather than a picture. A checkbox that
     shows the state and cannot change it is a worse checkbox than none.

     `toggle` is nil when the type declares no status. Not every type does, and
     drawing a box that cannot be ticked would invent a state the type has not
     got.
     */
    struct LinkedBadge {
        let symbol: String
        let done: Bool?
        let toggle: (() -> Void)?
        let open: () -> Void
        let standing: Standing
    }

    /**
     Whether the block behind a node is still a block.

     Three, not two. "Archived" and "deleted" are both *no longer active* and a
     person asking about one is asking about the other, but they are not the
     same thing to do something about: an archived block can be brought back
     from Hermes and a deleted one cannot, so a node that showed them
     identically would be advice as much as a label.

     Both are the format's own words rather than Hermes'. `archived` is a field
     on an object and the spec says a consumer must preserve it; a deletion is
     something the change log has to carry, so an object that has stopped
     arriving has stopped existing. Neither needed a Hermes-shaped question.
     */
    enum Standing {
        /// In Hermes, not archived.
        case live
        /// In Hermes, hidden.
        case archived
        /// Not in the mirror, and the daemon said so rather than failed to say.
        case gone
    }
    /// Already decoded. Loading a picture inside the body would re-read it on
    /// every frame of a drag, which is a file read per frame for as long as
    /// somebody is moving it.
    let picture: NSImage?
    @Binding var draft: String
    let commit: () -> Void
    /// Told the words; decides the box. Only a bare label has one.
    let fit: (String) -> Void


    /// Chrome is drawn in screen terms, not canvas terms.
    ///
    /// A one-point outline inside a transform is a sixth of a point at 0.15×
    /// and six points at 6×. Dividing by the zoom keeps every line and every
    /// handle the same size on the glass whatever the canvas is doing, which is
    /// what a person means by "a thin outline".
    private var hairline: CGFloat { 1 / zoom }
    private var handle: CGFloat { 7 / zoom }

    var body: some View {
        ZStack(alignment: combined(item.hAlign, item.vAlign)) {
            // The outline. A stroke and nothing else — no fill, because the
            // rule this canvas started from is that text has no background, and
            // a shape is a line round the outside rather than permission to
            // paint behind the words.
            if item.shape != .plain, item.image == nil {
                let box = CGRect(x: 0, y: 0, width: item.w, height: item.h)
                let weight = item.strokeWidth * hairline
                let inset = max(weight / 2, hairline)
                // Fill first, then the outline over it, so a thick border is
                // not half-covered by the thing it is drawn around.
                if let fill = Hex.color(item.fill) {
                    item.shape.path(in: box).fill(fill)
                }
                if item.strokeWidth > 0 {
                    let color = Hex.color(item.stroke) ?? Color.primary.opacity(0.7)
                    item.shape.path(in: box.insetBy(dx: inset, dy: inset))
                        .stroke(color, style: StrokeStyle(
                            lineWidth: weight,
                            dash: item.strokeStyle.dash(weight).map { $0 * hairline / max(hairline, 1) }
                        ))
                    // A double line is two lines. Drawn as a second, tighter
                    // copy of the same path rather than as one thick stroke with
                    // a gap knocked out of it — there is nothing behind this to
                    // knock a gap through to, since the canvas is see-through.
                    if item.strokeStyle == .double {
                        let gap = max(weight * 2, 3 * hairline)
                        item.shape.path(in: box.insetBy(dx: inset + gap, dy: inset + gap))
                            .stroke(color, lineWidth: weight)
                    }
                }
            }
            if let picture {
                Image(nsImage: picture)
                    .resizable()
                    // Stretched to the box rather than fitted inside it: the box
                    // is what somebody dragged, and letterboxing would leave a
                    // picture floating in a frame whose edges are the thing
                    // being resized. It arrives at its own proportions, so a
                    // distorted one is a drag somebody made.
                    .frame(width: item.w, height: item.h)
            } else if editing {
                // An NSTextView underneath, and it had to be. A SwiftUI field
                // cannot say where the selection is, and every one of bold,
                // italic and underline is "wrap what is selected" — without it
                // ⌘B would mean "put two asterisks at the end and hope", which
                // is not the feature.
                MarkdownField(
                    text: $draft,
                    commit: commit,
                    changed: fit,
                    align: item.hAlign.appKit,
                    color: NSColor(Hex.color(item.textColor) ?? .primary)
                )
            } else {
                // Rendered, not raw: the markers are what somebody typed and
                // the emphasis is what they meant. Links are live, which is the
                // one thing on this canvas that leaves it.
                //
                // In a scroll view, because a box may be smaller than what it
                // says. Two fingers move the words; a click and drag still moves
                // the node, because a scroll view answers scrolls and leaves
                // drags to whatever is underneath.
                ScrollView(.vertical, showsIndicators: false) {
                Text(CanvasText.attributed(item.text))
                    .font(.system(size: 12))
                    .multilineTextAlignment(item.hAlign.swiftUI)
                    .foregroundStyle(Hex.color(item.textColor) ?? .primary)
                    .tint(Theme.accent)
                    .fixedSize(horizontal: false, vertical: true)
                    // Room to breathe inside a shape, and none around a bare
                    // label — a label with padding is a label that does not
                    // start where it looks like it starts.
                    .padding(item.shape == .plain ? 0 : 10)
                    // Room for the mark, only when there is one.
                    .padding(.leading, badge == nil ? 0 : 16)
                    // The height is what makes vertical alignment work, and its
                    // absence is what stopped it working.
                    //
                    // A scroll view takes all the height it is offered and pins
                    // its content to the top, so the alignment on the frame
                    // *around* the scroll view never got a say — middle and
                    // bottom had been drawing exactly like top since the day
                    // words were allowed to overflow. Giving the content a
                    // minimum of the box's own height puts the argument back
                    // inside the scroll view, where it can be had: shorter than
                    // the box and the words sit where they were told to; taller
                    // and the minimum does nothing and it scrolls, which is the
                    // case the scroll view was added for.
                    .frame(maxWidth: .infinity, minHeight: item.h,
                           alignment: combined(item.hAlign, item.vAlign))
                }
                .scrollDisabled(item.image != nil)
            }
        }
        .frame(width: item.w, height: item.h, alignment: combined(item.hAlign, item.vAlign))
        // A little lift, so the things on the canvas read as being *on* it.
        //
        // Scaled by the zoom, like every other piece of geometry here: a shadow
        // that stayed four points while the canvas went to 6x would be a hairline
        // under a large card and a bruise under a small one.
        //
        // Regions get none, deliberately. They are the ground rather than
        // something resting on it, and a shadow under a region would put it at
        // the same height as the things it contains — which is exactly the
        // relationship the shadow exists to say something about.
        .shadow(color: .black.opacity(0.18), radius: 3 / zoom, x: 0, y: 1.5 / zoom)
        // The whole box answers the pointer, not just the letters. A label with
        // one short word in a wide box would otherwise be nearly unhittable, and
        // "touching an item highlights it" would be a lie most of the time.
        .contentShape(Rectangle())
        // The mark, at the leading edge and inside whatever shape there is.
        // Sized in screen terms like every other piece of chrome here.
        .overlay(alignment: .topLeading) {
            if let badge {
                HStack(spacing: 3) {
                    badgeView(badge)
                    standingTag(badge.standing)
                }
                .padding(.leading, item.shape == .plain ? 1 : 6)
                .padding(.top, item.shape == .plain ? 1 : 6)
            }
        }
        .overlay {
            // Hover is the faintest thing that can be seen; selection is
            // definite. They are the same rectangle at two strengths rather than
            // two different marks, because they are two stages of one idea.
            if let inRegion {
                // The mode has to be visible on the things it is about, not
                // only on the button that turned it on. Filled for members,
                // outlined for everything else, so one glance says what is in.
                RoundedRectangle(cornerRadius: 3 / zoom)
                    .fill(inRegion ? Theme.accent.opacity(0.16) : .clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 3 / zoom)
                            .strokeBorder(
                                inRegion ? Theme.accent : Color.primary.opacity(0.25),
                                style: StrokeStyle(lineWidth: hairline * 1.5,
                                                   dash: inRegion ? [] : [3 / zoom, 2 / zoom])
                            )
                    )
            } else if dropTarget {
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

    /// The icon, or the checkbox that has taken its place.
    @ViewBuilder
    private func badgeView(_ badge: LinkedBadge) -> some View {
        Button {
            if let toggle = badge.toggle { toggle() } else { badge.open() }
        } label: {
            Image(systemName: symbol(badge))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(badge.standing == .live
                                 ? (badge.done == true ? Theme.accent : Color.secondary)
                                 : Color.secondary)
                .frame(width: 14, height: 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help(badge))
    }

    private func symbol(_ badge: LinkedBadge) -> String {
        switch badge.standing {
        case .gone: return "questionmark.circle"
        case .archived: return "archivebox"
        // Only a block that is actually live gets a checkbox. Offering to tick
        // something archived would offer to change a thing that is not in play,
        // and the tick would land — quietly, on a block nobody is looking at.
        case .live: return badge.done.map { $0 ? "checkmark.circle.fill" : "circle" } ?? badge.symbol
        }
    }

    private func help(_ badge: LinkedBadge) -> String {
        switch badge.standing {
        case .gone: return "This block is no longer in Hermes Notes"
        case .archived: return "Archived in Hermes Notes — open it"
        case .live: return badge.toggle == nil ? "Open in Hermes Notes" : "Mark done, or not"
        }
    }

    /**
     What a node says when what it points at is no longer active.

     A word rather than only a symbol. The badge is fourteen points and shares
     its corner with a type icon and a checkbox, so on its own it is a change
     somebody notices a week later; "Archived" is read at a glance, which is the
     whole request.

     In canvas units, like the badge it sits beside — not divided by the zoom,
     which was the first thing tried. The chrome *above* a node is drawn outside
     the transform and has to compensate; the mark inside one is drawn within it
     and does not, so a tag that compensated would grow apart from the badge it
     is part of at every zoom but 1.

     And nothing else on the node changes. The colors here belong to whoever
     set them, and dimming a node to say something about Hermes would be
     spending somebody's styling on our message.
     */
    @ViewBuilder
    private func standingTag(_ standing: Standing) -> some View {
        if standing != .live {
            Text(standing == .archived ? "Archived" : "Not in Hermes")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(
                    Capsule().fill(standing == .archived
                                   ? Color.secondary.opacity(0.85)
                                   : Color.orange.opacity(0.9))
                )
                .fixedSize()
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

 Canvas coordinates have their origin at the center of the pane when the canvas
 is at rest, which is what the zoom arithmetic in `DeskChrome` already assumes.
 Everything that converts between the two goes through `canvasPoint`, once, so
 there is one place to be wrong.
 */
struct CanvasSurface: View {
    @ObservedObject var chrome: DeskChrome
    @ObservedObject var model: CanvasModel
    /// Open the composer with these words in it, and say what it made.
    ///
    /// Handed in rather than reached for: the canvas has no business knowing
    /// what a composer is, and this keeps the one place it touches Hermes down
    /// to a closure somebody else supplies.
    var onCompose: (String, @escaping (String) -> Void) -> Void = { _, _ in }
    /// Put the desk away, for the one action that sends somebody somewhere else.
    var onLeave: () -> Void = {}

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
    /**
     Whether the pointer is on a control rather than on the canvas.

     Every piece of chrome sets this on the way in and clears it on the way out,
     and the cursor reads it. A flag rather than a set of rectangles because the
     chrome moves — the strip grows a tool, the menu opens, the grips appear and
     disappear with the selection — and a rule written in coordinates would have
     to be corrected every time any of that changed.

     `onHover` and not the continuous one: enter and exit is the whole question,
     and the continuous variant would fire this on every pixel of movement for an
     answer that has not changed.
     */
    @State private var overChrome = 0
    /// The item whose delete has been asked for but not yet confirmed.
    @State private var confirmingDelete: UUID?
    /// The group delete has been asked for but not answered.
    @State private var confirmingGroupDelete = false
    /// How far through clearing the canvas somebody is. Reset by a click
    /// anywhere else, like every other question this surface asks.
    @State private var clearStep = 0
    @State private var fileMenuOpen = false
    @State private var confirmingFile: CanvasFile?
    /// Which thing's inspector is open, if any. One at a time, and tied to the
    /// selection: an inspector for something that is no longer selected is a
    /// panel editing a thing nobody can see.
    @State private var inspecting: UUID?
    /// What is currently lining up, drawn while the drag lasts and gone the
    /// moment it ends. A guide that outlives its gesture is a line on the canvas
    /// nobody drew.
    @State private var guides: [Snap.Guide] = []
    /// Whether the connector being bent is currently held straight.
    @State private var straightened = false

    /// Controls that vanish under the pointer never report leaving it. These are
    /// the moments a control disappears — the selection changing takes the grips
    /// and the delete with it, and a menu closing takes itself — so the count is
    /// put back to what can be seen rather than what was last counted.
    private func forgetChrome() { overChrome = 0 }

    @State private var tool: CanvasTool?
    @State private var toolPoint: CGPoint?
    /// What the text tool will place next. Kept on the surface rather than in
    /// the model: it is a state of the tool strip, not a fact about the canvas,
    /// and a canvas reopened tomorrow should not still be armed with a triangle.
    @State private var shape: CanvasShape = .plain
    @State private var openMenu: CanvasTool?
    /// The selector, when it is on. A mode, so it stays on until it is turned
    /// off or used — a person drawing three boxes round three groups should not
    /// have to click the tool three times.
    @State private var armed: CanvasTool?
    /// The marquee being dragged, in canvas coordinates.
    @State private var marquee: CGRect?
    @State private var marqueeStart: CGPoint?
    /// The region being dragged, and how far it has gone so far — a drag reports
    /// its total travel, so the model is told the difference each frame.
    @State private var draggingRegion: UUID?
    @State private var regionOrigin: CGSize?
    /// Said out loud when a picture could not be added, rather than drawing an
    /// empty box and letting somebody work out why.
    @State private var trouble: String?
    /// A picture tool has been dropped and is waiting to be told where the
    /// picture comes from. Both points: where to draw the question, and where
    /// the picture goes once it is answered.
    @State private var askingImage: (screen: CGPoint, canvas: CGPoint)?

    /// What Hermes says about the blocks this canvas is linked to, and the
    /// types they are. Read from the mirror, so it is free and works offline;
    /// refreshed when the set of links changes and when one of them is written
    /// to, rather than on a timer nobody asked for.
    @State private var linked: [String: Daemon.LinkedBlock] = [:]
    @State private var blockTypes: [String: Daemon.BlockType] = [:]
    /// Polls the sync cursor so a canvas left open notices what Hermes did.
    @State private var watch: MirrorWatch?
    /// Keeps the canvas and the collection behind it in step. One per surface,
    /// made on appear, and quiet unless a collection is configured.
    @StateObject private var sync = CanvasSyncBox()
    /// Ids the daemon has told us it does not hold.
    ///
    /// Kept separately from `linked` rather than inferred from its absence,
    /// because absence has two causes and only one of them is news. See
    /// `refreshLinks`.
    @State private var goneBlocks: Set<String> = []

    /// Decoded pictures, by the item that shows them. Rebuilt when the set of
    /// pictures changes and not once per frame — decoding a screenshot inside a
    /// view body is a megabyte of work every time anything moves.
    @State private var pictures: [UUID: NSImage] = [:]
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
    /// Whether ⌘ is down, which turns a drop onto a region into a drop into it.
    @State private var joining = false
    /// A region in add-mode: clicking things puts them in or takes them out.
    @State private var addingTo: UUID?
    /// Where the bend was when the handle was picked up.
    @State private var bendAtStart: CGSize?

    /// Open over the canvas, pointing the instant a button goes down, closed
    /// once that press starts pulling the canvas about.
    /**
     How big a node's own buttons are drawn.

     They follow the zoom rather than staying a fixed size on the glass, which
     is the opposite of the rule the guides and outlines follow — and it is what
     was asked for. A guide is a measuring instrument and wants to be the same
     thickness always; a button belongs to the thing it is attached to, and one
     that stayed put while its node grew to fill the screen would look like it
     had come loose.

     Clamped, because "follows the zoom" taken literally means a two-point
     target at 0.15x and a button the size of a saucer at 6x. Between a half and
     twice, which keeps it recognizably attached without ever making it
     unclickable.
     */
    private var buttonScale: CGFloat { min(max(chrome.zoom, 0.5), 2) }

    /**
     The row of buttons above a thing's top-right corner.

     One stack rather than each button positioned by arithmetic, and the
     arithmetic is why. Each was placed by counting slots back from the corner,
     with a hand-written allowance for the delete button growing into the word
     "Sure?" — and that allowance was a guess at how wide the word is. It was
     too small, so asking to delete something slid the capsule left over the
     buttons beside it.

     The guess is not fixable by a better number. "Sure?" is text in the user's
     system font at a size that scales with the zoom, and the only thing that
     knows how wide it is is the thing that lays it out. So it lays it out: an
     `HStack` measures its own contents, and the row is pinned by its *trailing*
     edge — which is what should not move — inside a lane wide enough for
     anything it might hold. The lane has no background, so the empty part of it
     catches nothing.
     */
    private func buttonRow<Content: View>(
        at corner: CGPoint,
        @ViewBuilder content: () -> Content
    ) -> some View {
        // Where the outermost button's right edge sits: the same place it sat
        // when each of these was positioned by hand.
        let edge = corner.x + 15.5 * buttonScale
        let lane: CGFloat = 400
        return HStack(spacing: 4 * buttonScale) { content() }
            .fixedSize()
            .frame(width: lane, alignment: .trailing)
            .position(x: edge - lane / 2, y: corner.y - 9 * buttonScale)
    }

    private var cursor: NSCursor {
        if tool != nil || armed == .select { return .crosshair }
        // Pulling something — the canvas itself, or one thing on it.
        if dragging || movingId != nil { return .closedHand }
        // Over a thing, or pressed on the canvas. Both are "this click will do
        // something to what is under you", which is what a pointing finger has
        // always meant.
        if overChrome > 0 { return .pointingHand }
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
                background(geo)

                // Under everything: a region is the ground the rest sits on.
                regionLayer(geo)

                // Under the items, so a line runs behind the boxes it joins
                // rather than across their faces.
                lines(geo.size)

                content(geo)

                // Over everything, because a guide that a box can cover is a
                // guide you cannot use to place that box.
                guideLayer(geo.size)

                // Everything that floats over the drawing, in one group.
                //
                // A view builder takes ten children and this stack wanted
                // twelve. Past that it does not fail with "too many" — it hands
                // the type checker an expression it will not finish, and says
                // so about a line that is not the problem.
                Group {
                    inspectorPanel(geo)
                    // Whatever the selection is, its own buttons. Several at
                    // once get one menu rather than a set each — twelve little
                    // crosses over six boxes is not an offer, it is confetti.
                    selectionChrome(geo)
                    linkChrome(geo.size)
                    carriedTool
                    imageQuestion
                    marqueeBox(geo.size)
                    CursorArea(cursor: cursor)
                    troubleNote
                }
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
                    cursor.set()
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
            .overlay(alignment: .bottomTrailing) {
                CanvasControls(chrome: chrome).chrome($overChrome).padding(14)
            }
            .onAppear {
                loadPictures()
                refreshLinks()
                // A canvas is left open. Everything it says about Hermes was
                // read once, so archiving a block somewhere else changed
                // nothing here until the set of links happened to move — which
                // for a canvas nobody is editing is never.
                //
                // The same watcher the board and the agenda use: one local read
                // of the sync cursor every twenty seconds, and a reload only
                // when it has actually moved. Nothing new had to be built; this
                // view simply had not been told it was long-lived.
                let w = MirrorWatch {
                    refreshLinks()
                    // The same tick. A canvas backed by a collection has two
                    // things to catch up on when the mirror moves — what the
                    // blocks say, and where they now sit — and they are the
                    // same news arriving.
                    sync.inner.pull()
                }
                w.start()
                watch = w
                sync.inner.onPulled = { document in
                    // Not while somebody is holding something. A pull that
                    // landed mid-drag would take the node out from under the
                    // pointer, and the drag would finish by writing it back to
                    // where it was — a fight nobody can see the far side of.
                    guard dragging == false, draggingRegion == nil, model.editing == nil else { return }
                    model.adopt(document)
                }
                model.sync = sync.inner
            }
            .onDisappear {
                watch?.stop()
                watch = nil
            }
            .onChange(of: model.items.compactMap(\.blockId)) { _ in refreshLinks() }
            .onChange(of: model.selected) { now in
                forgetChrome()
                if inspecting != nil, inspecting != now, model.selectedLink != inspecting { inspecting = nil }
            }
            .onChange(of: model.selectedLink) { now in
                forgetChrome()
                if inspecting != nil, inspecting != now, model.selected != inspecting { inspecting = nil }
            }
            .onChange(of: openMenu) { _ in forgetChrome() }
            /**
             Closing the inspector closes the color panel.

             `NSColorPanel` is shared and persistent: it is one panel for the
             whole application, it stays up until something closes it, and it
             remembers whatever it was last pointed at. So a well opened once
             left it hanging around, and the next well found a panel already
             open — which is why picking a color felt like it was showing the
             last thing rather than this one.

             Tied to the inspector rather than to the pick itself, because the
             pick is continuous. Closing it on the first change would mean the
             panel shut the instant somebody touched the color wheel, which is
             one drag into choosing rather than the end of it.
             */
            .onChange(of: inspecting) { now in
                guard now == nil, NSColorPanel.sharedColorPanelExists,
                      NSColorPanel.shared.isVisible else { return }
                NSColorPanel.shared.close()
            }
            // Keyed on which items have pictures, not on the items themselves —
            // otherwise every drag of anything would reload every picture.
            .onChange(of: model.items.compactMap(\.image)) { _ in loadPictures() }
            .overlay(alignment: .trailing) {
                CanvasToolStrip(
                    dragging: $tool,
                    shape: $shape,
                    openMenu: $openMenu,
                    armed: $armed,
                    overChrome: $overChrome,
                    clearStep: $clearStep,
                    fileMenuOpen: $fileMenuOpen,
                    confirmingFile: $confirmingFile,
                    file: { entry in handleFile(entry) },
                    clear: { model.clearAll() },
                    track: { _, at in toolPoint = local(at, geo) },
                    drop: { which, at in dropped(which, at: at, in: geo) },
                    pickImage: { _ in }
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
    /**
     What a drag would be dropped on, given a point *in this surface*.

     In the surface's own coordinates, not the screen's — which is the bug this
     signature exists to stop repeating. The item drag is a global gesture and
     the region drag is a local one, and this used to convert both as though
     they were global. Dragging a region onto a node therefore tested a point
     offset by the whole surface's origin, found nothing there, and dropped
     without connecting anything. Nothing failed; the drop simply did nothing,
     which is the hardest kind of wrong to see.

     The conversion now belongs to whichever caller knows what space its gesture
     is in, because that is the only place that can know.
     */
    private func dropTarget(at point: CGPoint, moving: UUID, in geo: GeometryProxy) -> UUID? {
        let here = canvasPoint(point, in: geo.size)
        // What a region is carrying with it, which it cannot be dropped onto.
        // Its members travel under the pointer for the whole drag, so without
        // this the likeliest outcome of moving a region is a line from the box
        // to something already inside it.
        let carried = Set(model.regions.first { $0.id == moving }?.members ?? [])

        // An item first: a region is mostly the things it holds, and dropping on
        // one of those means that one, not the box around it.
        if let hit = model.items.reversed().first(where: {
            $0.id != moving && !carried.contains($0.id) && $0.rect.contains(here)
        }) {
            return hit.id
        }
        // Then a region — but never one that holds the thing being carried.
        // Joining something to the box it is already inside is a line from a
        // thing to itself, drawn the long way round.
        if let region = model.region(at: here, excluding: moving),
           !region.members.contains(moving) {
            return region.id
        }
        return nil
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

    /**
     Ask the mirror about every block this canvas points at.

     Off the main thread and all at once, because it happens when the set of
     links changes rather than while anything is being dragged. A node whose
     block has gone is left without an answer rather than given a wrong one —
     the node still draws, and says it is pointing at nothing.
     */
    private func refreshLinks() {
        let ids = Set(model.items.compactMap(\.blockId))
        guard !ids.isEmpty else {
            linked = [:]
            return
        }
        Task.detached(priority: .utility) {
            var found: [Daemon.LinkedBlock] = []
            var gone: Set<String> = []
            var reachable = true
            for id in ids {
                do {
                    found.append(try Daemon.linked(id))
                } catch let failure as Daemon.Failure where failure.answered {
                    // The mirror was asked and said no. That is a deletion:
                    // the format requires deletions to arrive in the change
                    // log, so a block that has stopped being in the mirror has
                    // stopped being in Hermes — it is not merely unmentioned.
                    gone.insert(id)
                } catch {
                    // Nothing answered. Says nothing about the block, so this
                    // says nothing about the node — the alternative is a canvas
                    // that reports every link as deleted whenever the daemon is
                    // restarting, which is alarming and wrong in the same
                    // moment.
                    reachable = false
                }
            }
            let types = (try? Daemon.types()) ?? []
            await MainActor.run {
                guard reachable || !found.isEmpty else { return }
                linked = Dictionary(uniqueKeysWithValues: found.map { ($0.id, $0) })
                goneBlocks = gone
                if !types.isEmpty {
                    blockTypes = Dictionary(uniqueKeysWithValues: types.map { ($0.id, $0) })
                }
            }
        }
    }

    /**
     What a node should show for the block behind it.

     Everything here is read rather than remembered: the type, the icon, whether
     the type has a status at all and what the status currently is. A node stores
     an id and nothing else, so none of this can be stale — which is the point of
     storing only the id.
     */
    private func badge(for item: CanvasItem) -> CanvasItemView.LinkedBadge? {
        guard let id = item.blockId else { return nil }
        guard let block = linked[id] else {
            // Only when the daemon said so. An id we simply have no answer for
            // yet draws nothing at all, because "this points at a block that is
            // gone" is a claim and we would not be in a position to make it.
            guard goneBlocks.contains(id) else { return nil }
            return .init(symbol: "questionmark.circle", done: nil, toggle: nil,
                         open: {}, standing: .gone)
        }
        let type = block.typeId.flatMap { blockTypes[$0] }
        // An archived block keeps its status and loses its checkbox. The value
        // is still true and still worth showing; ticking it is the thing that
        // stops making sense, because finishing something nobody can see is a
        // write into a drawer.
        let canFinish = type?.statusKey != nil && !(type?.completeValues.isEmpty ?? true)
        return .init(
            symbol: type?.icon.map(sfSymbol(for:)) ?? "doc",
            done: canFinish ? isDone(block) : nil,
            toggle: canFinish && !block.archived ? { toggleDone(block, type: type) } : nil,
            open: { open(block) },
            standing: block.archived ? .archived : .live
        )
    }

    /// Hermes names its icons in its own vocabulary; this is the small part of
    /// it that has an obvious equivalent here. Anything unrecognized falls back
    /// to a page, which is what a block is when nothing more is known.
    private func sfSymbol(for key: String) -> String {
        switch key {
        case "check-square", "checkSquare", "list-checks": return "checklist"
        case "calendar", "calendar-days": return "calendar"
        case "user", "person": return "person"
        case "folder": return "folder"
        case "star": return "star"
        case "tag": return "tag"
        case "workflow": return "point.topleft.down.curvedto.point.bottomright.up"
        case "file-text", "fileText", "scroll": return "doc.text"
        default: return "doc"
        }
    }

    /// Tick it, or untick it, through the binding — the daemon's own write,
    /// which stamps the completion and keeps a series in step.
    private func toggleDone(_ block: Daemon.LinkedBlock, type: Daemon.BlockType?) {
        guard let type, let want = isDone(block) ? type.undoneValue : type.doneValue else { return }
        Task.detached(priority: .userInitiated) {
            try? Daemon.write(["kind": "complete", "blockId": block.id, "status": want])
            await MainActor.run { refreshLinks() }
        }
    }

    /// Going to Hermes means leaving here.
    ///
    /// The desk is an overlay over whatever somebody was doing, and opening a
    /// block behind it would put the page they asked for underneath the thing
    /// they asked from. So the overlay goes first, and the browser arrives on an
    /// empty screen rather than beneath one.
    private func open(_ block: Daemon.LinkedBlock) {
        guard let url = block.url.flatMap(URL.init(string:)) else {
            trouble = "That block has no address yet"
            return
        }
        onLeave()
        Opener.open(url)
    }

    /// Whether a linked block counts as finished, by its own type's rule.
    private func isDone(_ block: Daemon.LinkedBlock) -> Bool {
        guard let status = block.status,
              let type = block.typeId.flatMap({ blockTypes[$0] }) else { return false }
        return type.completeValues.contains(status)
    }

    private func loadPictures() {
        var next: [UUID: NSImage] = [:]
        for item in model.items where item.image != nil {
            // Kept from last time when it is the same picture, so adding one
            // does not re-decode the others.
            if let already = pictures[item.id] {
                next[item.id] = already
            } else if let data = model.imageData(for: item), let image = NSImage(data: data) {
                next[item.id] = image
            }
        }
        pictures = next
    }

    /**
     A picture, where the tool was let go.

     The question of which picture is asked after the drag rather than before it,
     so the gesture that says *where* is the same one every other tool uses and
     the answer lands exactly where it was dropped.
     */
    private func add(_ source: ImageSource, at where_: CGPoint) {
        let picked: PickedImage?
        switch source {
        case .clipboard: picked = ImagePicker.fromClipboard()
        case .file: picked = ImagePicker.fromFile()
        }
        guard let picked else {
            trouble = source == .clipboard
                ? "There is no picture on the clipboard"
                : "That file could not be read as a picture"
            return
        }
        if !model.addImage(picked.data, extension: picked.ext, pixelSize: picked.pixelSize, at: where_) {
            trouble = "That picture could not be saved"
        }
    }

    /// A point on the canvas, as a point on the glass. The inverse of
    /// `canvasPoint`, and the two must stay that way.
    private func screenPoint(_ p: CGPoint, in size: CGSize) -> CGPoint {
        CGPoint(x: p.x * chrome.zoom + chrome.pan.width + size.width / 2,
                y: p.y * chrome.zoom + chrome.pan.height + size.height / 2)
    }

    /// The shape of a line, or nothing if either end has gone.
    private func geometry(of link: CanvasLink) -> LinkGeometry? {
        guard let a = model.rect(of: link.from), let b = model.rect(of: link.to) else { return nil }
        return LinkGeometry.of(from: a, to: b, bend: link.bend)
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
                let held = straightened && model.selectedLink == link.id
                let own = Hex.color(link.color)
                let color: Color = held
                    ? Theme.snapGuide
                    : (chosen ? Theme.accent : (own ?? .primary.opacity(under ? 0.85 : 0.55)))
                // Somebody's own weight is theirs. The selected and hovered
                // states thicken a line that has not been given one rather than
                // overriding one that has.
                let width: CGFloat = link.width > 0
                    ? link.width
                    : (chosen || under ? 2 : 0)
                guard width > 0 || link.width == 0 else { continue }

                var path = Path()
                path.move(to: start)
                path.addQuadCurve(to: end, control: control)
                if link.width > 0 {
                    context.stroke(path, with: .color(color), style: StrokeStyle(
                        lineWidth: width, dash: link.style.dash(width)
                    ))
                    if link.style == .double {
                        // The same curve, shifted across its own direction.
                        let gap = max(width * 1.6, 2.5)
                        let d = g.arrival
                        let side = CGVector(dx: -d.dy * gap, dy: d.dx * gap)
                        var twin = Path()
                        twin.move(to: CGPoint(x: start.x + side.dx, y: start.y + side.dy))
                        twin.addQuadCurve(
                            to: CGPoint(x: end.x + side.dx, y: end.y + side.dy),
                            control: CGPoint(x: control.x + side.dx, y: control.y + side.dy)
                        )
                        context.stroke(twin, with: .color(color), lineWidth: width)
                    }
                }

                guard link.width > 0 else { continue }
                // The head, at the end that was dropped on. Drawn as a filled
                // triangle rather than two strokes so it stays solid at any
                // angle instead of showing a notch at the point.
                let d = g.arrival
                let tip = end
                // Sized from the line it ends. A head that stayed 9 points long
                // while the line grew to 8 looked like a pin stuck in the end of
                // a pipe. Six and three times the weight keeps the same
                // proportions the default had, and a floor so a hairline still
                // arrives at something.
                let head_len = max(width * 6, 5)
                let head_half = max(width * 3, 2.5)
                let back = CGPoint(x: tip.x - d.dx * head_len, y: tip.y - d.dy * head_len)
                let side = CGVector(dx: -d.dy, dy: d.dx)
                var head = Path()
                head.move(to: tip)
                head.addLine(to: CGPoint(x: back.x + side.dx * head_half, y: back.y + side.dy * head_half))
                head.addLine(to: CGPoint(x: back.x - side.dx * head_half, y: back.y - side.dy * head_half))
                head.closeSubpath()
                context.fill(head, with: .color(color))
            }
        }
        .allowsHitTesting(false)
    }

    /**
     The boxes drawn round groups.

     Each one asks where its members are, every time. That is the whole of
     "expands to contain what is moved": nothing watches for a move, because the
     box is not a thing that could be out of date — it is the extent of what is
     inside it, computed now.

     Drawn as views rather than into a `Canvas` because a region carries a title
     that can be styled and aligned like any other text, and text in a canvas
     context is a second text renderer to keep in step with the first.
     */
    @ViewBuilder
    private func regionLayer(_ geo: GeometryProxy) -> some View {
        ZStack {
            ForEach(model.regions) { region in
                if let box = model.box(of: region) {
                    let chosen = model.selectedRegion == region.id
                    let weight = region.strokeWidth / chrome.zoom
                    let aimed = linkTarget == region.id
                    ZStack {
                        RoundedRectangle(cornerRadius: 10 / chrome.zoom)
                            .fill(aimed ? Theme.accent.opacity(0.14) : (Hex.color(region.fill) ?? .clear))
                        if region.strokeWidth > 0 {
                            RoundedRectangle(cornerRadius: 10 / chrome.zoom)
                                .strokeBorder(
                                    chosen || aimed
                                        ? Theme.accent
                                        : (Hex.color(region.stroke) ?? .primary.opacity(0.35)),
                                    style: StrokeStyle(
                                        lineWidth: chosen || aimed
                                            ? max(weight, 2 / chrome.zoom)
                                            : weight,
                                        dash: aimed ? [] : region.strokeStyle.dash(weight)
                                    )
                                )
                        }
                    }
                    .frame(width: box.width, height: box.height)
                    // The name, above the box rather than in it. One line: it is
                    // a label for a group and not a paragraph, and a name that
                    // wrapped would push the box down away from the things it is
                    // drawn around.
                    .overlay(alignment: region.hAlign.frame) {
                        if !region.title.isEmpty {
                            Text(CanvasText.attributed(region.title))
                                .font(.system(size: 11, weight: .semibold))
                                .lineLimit(1)
                                .foregroundStyle(Hex.color(region.textColor) ?? .secondary)
                                .padding(.horizontal, 4 / chrome.zoom)
                                .offset(y: -(box.height / 2) - CanvasRegion.titleHeight / 2)
                        }
                    }
                    .offset(x: box.midX, y: box.midY)
                }
            }
        }
        .scaleEffect(chrome.zoom)
        .offset(chrome.pan)
        // The region is clicked through the background, which knows what is on
        // top of it. A region that took its own clicks would take them from the
        // things inside it, which is the opposite of what it is for.
        .allowsHitTesting(false)
    }

    /**
     The lines that appear while something is being dragged into place.

     Drawn in screen space like the connectors and the grid, so a guide is one
     point wide whatever the zoom — a guide that thickens as you zoom in stops
     being a reference and becomes a band with a middle you have to judge.

     Dashed, and in their own color rather than the accent: an accent-colored
     guide over an accent-colored selection is two meanings in one color, and
     the one that matters at that moment is the one that is moving.
     */
    @ViewBuilder
    private func guideLayer(_ size: CGSize) -> some View {
        Canvas { context, _ in
            for guide in guides {
                var path = Path()
                path.move(to: screenPoint(guide.from, in: size))
                path.addLine(to: screenPoint(guide.to, in: size))
                context.stroke(
                    path,
                    with: .color(Theme.snapGuide),
                    style: StrokeStyle(lineWidth: 1, dash: guide.reason == .grid ? [2, 3] : [4, 3])
                )
            }
        }
        .allowsHitTesting(false)
    }

    /**
     Delete a selected item, having asked first.

     Two clicks, in the same place, rather than a dialog. The thing being
     deleted is on the canvas in front of somebody — it does not need describing
     to them in a box that covers it up — so the button simply changes into the
     question and waits. Clicking anywhere else is the answer "no", which is
     what most people do with a confirmation they did not mean to open.

     A connector has no such step, on purpose. A line is one drag to redraw and
     nothing of it is lost; a text item is what somebody wrote and a picture is
     what they went and found. The cost of getting it wrong is not the same, so
     the ceremony is not the same either.
     */
    @ViewBuilder
    private func itemDelete(_ item: CanvasItem, in size: CGSize) -> some View {
        let corner = screenPoint(CGPoint(x: item.x + item.w, y: item.y), in: size)
        let asking = confirmingDelete == item.id
        // Becoming a Hermes block, offered only where it means something.
        //
        // Not on a picture: a screenshot has no first line to be a title and no
        // rest to be a body, and "make a note of this image" is a different
        // feature with a different shape. Not on something already linked
        // either — the link is the thing this makes, and making it twice makes
        // two blocks from one node.
        // One button, two jobs, and which one it is doing is a fact about the
        // node rather than a mode. Before there is a block it makes one; after
        // there is, it goes to it — because a node that had become a block had
        // nothing left that would open it, the badge having become a checkbox.
        let linkedBlock = item.blockId.flatMap { linked[$0] }
        let toHermes = Button {
            if let block = linkedBlock {
                open(block)
            } else if item.blockId != nil {
                trouble = "That block is not in the mirror yet"
            } else {
                let words = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !words.isEmpty else {
                    trouble = "Write something in it first"
                    return
                }
                onCompose(words) { id in model.attach(item.id, to: id) }
            }
        } label: {
            // The same disc as the one beside it, because it is the same kind
            // of thing: a white mark on a plain gray circle. It had a black
            // fill and an accent ring to say "this one is linked" — but the
            // node already says that, twice, with the badge and the tag, and a
            // button that changes color to report a state it does not control
            // is a third voice saying it in the row where the controls live.
            WingMark(size: 9 * buttonScale)
                .frame(width: 13 * buttonScale, height: 13 * buttonScale)
                .contentShape(Rectangle())
                .foregroundStyle(.white)
                .background(Circle().fill(Color.secondary))
        }
        .buttonStyle(.plain)
        .help(item.blockId == nil ? "Make this a block in Hermes Notes" : "Open in Hermes Notes")
        .chrome($overChrome)

        let info = Button {
            inspecting = inspecting == item.id ? nil : item.id
        } label: {
            Image(systemName: "info")
                .font(.system(size: 8 * buttonScale, weight: .bold))
                .frame(width: 13 * buttonScale, height: 13 * buttonScale)
                .contentShape(Rectangle())
                .foregroundStyle(.white)
                .background(Circle().fill(inspecting == item.id ? Theme.accent : Color.secondary))
        }
        .buttonStyle(.plain)
        .help("Appearance")
        .chrome($overChrome)

        let remove = Button {
            if asking {
                model.delete(item.id)
                confirmingDelete = nil
                inspecting = nil
            } else {
                confirmingDelete = item.id
            }
        } label: {
            Group {
                if asking {
                    Text("Sure?")
                        .font(Theme.chrome(10 * buttonScale, weight: .semibold))
                        .padding(.horizontal, 7 * buttonScale)
                        .frame(height: 16 * buttonScale)
                } else {
                    Image(systemName: "xmark")
                        .font(.system(size: 7 * buttonScale, weight: .bold))
                        .frame(width: 13 * buttonScale, height: 13 * buttonScale)
                }
            }
            .contentShape(Rectangle())
            .foregroundStyle(.white)
            .background(Capsule().fill(Theme.danger))
        }
        .buttonStyle(.plain)
        .help(asking ? "Click again to delete" : "Delete this")
        .chrome($overChrome)

        // All just outside the top-right corner, where they are not over the
        // thing one of them would remove. Delete is the outermost, so the
        // dangerous one is furthest from where the others are reached from —
        // and so that the one which changes width does it away from the rest.
        buttonRow(at: corner) {
            if item.image == nil { toHermes }
            info
            remove
        }
    }

    /// Save the canvas to a file, or replace it with one.
    private func handleFile(_ entry: CanvasFile) {
        switch entry {
        case .save:
            guard let url = CanvasFiles.destination(.json, named: "Canvas.json") else { return }
            if let bad = CanvasFiles.write(model.export(), to: url) { trouble = bad }
        case .png, .pdf:
            // The whole canvas, not the part of it anybody happens to be looking
            // at. An export is the thing itself rather than a screenshot of a
            // viewport, so it is drawn at one to one from the extent of
            // everything on it.
            guard let extent = CanvasPrint.extent(items: model.items, regions: model.regions) else {
                trouble = "There is nothing on this canvas yet"
                return
            }
            let page = CanvasPrint(
                items: model.items, links: model.links, regions: model.regions,
                pictures: pictures, bounds: extent
            )
            let png = entry == .png
            guard let url = CanvasFiles.destination(png ? .png : .pdf,
                                                    named: png ? "Canvas.png" : "Canvas.pdf") else { return }
            let data = png ? CanvasRender.png(page) : CanvasRender.pdf(page, size: extent.size)
            guard let data else {
                trouble = "That canvas could not be drawn"
                return
            }
            if let bad = CanvasFiles.write(data, to: url) { trouble = bad }
        case .load:
            guard let url = CanvasFiles.source() else { return }
            let read = CanvasFiles.read(url)
            if let canvas = read.canvas { model.load(canvas) } else { trouble = read.trouble }
        }
    }

    /// A tool let go somewhere on the canvas.
    private func dropped(_ which: CanvasTool, at screen: CGPoint, in geo: GeometryProxy) {
        let here = local(screen, geo)
        toolPoint = nil
        // Ignore a drop that never left the strip: that is a click on a tool,
        // and a click has nowhere to put one.
        guard here.x < geo.size.width - Self.stripWidth else { return }
        switch which {
        case .text:
            model.addText(at: canvasPoint(here, in: geo.size), shape: shape)
        case .select:
            // Armed by a click, not placed by a drag. Nothing to drop.
            break
        case .image:
            // Where, then what. The question of which picture is asked at the
            // point it was dropped, so the answer arrives where the drag ended.
            askingImage = (here, canvasPoint(here, in: geo.size))
        }
    }

    /**
     The appearance panel, drawn on the canvas rather than in a popover.

     It was a popover, and a popover closes when anything else takes the focus —
     which is exactly what opening the color panel does. So reaching for the
     color wheel dismissed the thing you had reached from, and the auto-close
     then took the color panel away with it. The panel flew off as you moved
     toward it.

     Every other menu on this surface is a drawn overlay for the same reason.
     Nothing here should close because focus moved; these things close when
     somebody clicks the canvas, which is the one gesture that means "done".

     Placed beside whatever it is about, and kept on screen: a panel half off the
     right-hand edge is a panel with half its controls missing.
     */
    @ViewBuilder
    private func inspectorPanel(_ geo: GeometryProxy) -> some View {
        if let id = inspecting, let anchor = inspectorAnchor(id, in: geo.size) {
            CanvasInspector(
                model: model,
                item: model.item(id),
                link: model.links.first { $0.id == id },
                region: model.regions.first { $0.id == id }
            )
            .background(
                RoundedRectangle(cornerRadius: 11)
                    .fill(.background.opacity(0.96))
                    .overlay(
                        RoundedRectangle(cornerRadius: 11)
                            .strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.22), radius: 14, y: 4)
            )
            .chrome($overChrome)
            .position(anchor)
        }
    }

    /// Where the panel sits: to the right of the thing, or to its left when
    /// there is no room, and never off the top or bottom.
    private func inspectorAnchor(_ id: UUID, in size: CGSize) -> CGPoint? {
        guard let box = model.rect(of: id) ?? geometryBox(of: id) else { return nil }
        let width: CGFloat = 268, height: CGFloat = 300
        let right = screenPoint(CGPoint(x: box.maxX, y: box.minY), in: size)
        var x = right.x + 20 + width / 2
        if x + width / 2 > size.width - Self.stripWidth {
            x = screenPoint(CGPoint(x: box.minX, y: 0), in: size).x - 20 - width / 2
        }
        let y = min(max(right.y + height / 2 - 20, height / 2 + 8), size.height - height / 2 - 8)
        return CGPoint(x: min(max(x, width / 2 + 8), size.width - width / 2 - 8), y: y)
    }

    /// A connector has no rect of its own; its panel hangs off its handle.
    private func geometryBox(of id: UUID) -> CGRect? {
        guard let link = model.links.first(where: { $0.id == id }), let g = geometry(of: link) else { return nil }
        return CGRect(x: g.handle.x, y: g.handle.y, width: 1, height: 1)
    }

    /// The grip and buttons on a selected connector.
    @ViewBuilder
    private func linkChrome(_ size: CGSize) -> some View {
        if let id = model.selectedLink,
           let link = model.links.first(where: { $0.id == id }),
           let g = geometry(of: link) {
            handleControls(for: link, g: g, in: size)
        }
    }

    /// The ghost under the pointer. Drawn over everything, because a tool being
    /// carried is not on the canvas yet and should not look as though it is.
    @ViewBuilder
    private var carriedTool: some View {
        if let tool, let at = toolPoint {
            Image(systemName: tool == .text ? shape.symbol : tool.symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.accent)
                .padding(6)
                .background(Circle().fill(.background.opacity(0.8)))
                .position(at)
                .allowsHitTesting(false)
        }
    }

    /// Where a dropped picture should come from, asked where it landed.
    @ViewBuilder
    private var imageQuestion: some View {
        if let asking = askingImage {
            ImageMenu { source in
                askingImage = nil
                add(source, at: asking.canvas)
            }
            .fixedSize()
            .chrome($overChrome)
            // Just below and right of where it landed, so the question is not
            // sitting on top of the place the answer will go.
            .position(x: asking.screen.x + 66, y: asking.screen.y + 34)
        }
    }

    /// The box being dragged round things, while it is being dragged.
    @ViewBuilder
    private func marqueeBox(_ size: CGSize) -> some View {
        if let box = marquee {
            let a = screenPoint(CGPoint(x: box.minX, y: box.minY), in: size)
            let b = screenPoint(CGPoint(x: box.maxX, y: box.maxY), in: size)
            Rectangle()
                .strokeBorder(Theme.accent, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                .background(Rectangle().fill(Theme.accent.opacity(0.07)))
                .frame(width: abs(b.x - a.x), height: abs(b.y - a.y))
                .position(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
                .allowsHitTesting(false)
        }
    }

    /// A picture that did not arrive has to say why. The alternative is a menu
    /// item that sometimes does nothing, which is indistinguishable from a menu
    /// item that is broken.
    @ViewBuilder
    private var troubleNote: some View {
        if let trouble {
            Text(trouble)
                .font(Theme.chrome(11))
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Capsule().fill(.background.opacity(0.9)))
                .overlay(Capsule().strokeBorder(Theme.danger.opacity(0.5), lineWidth: 1))
                .transition(.opacity)
                .allowsHitTesting(false)
                .task {
                    try? await Task.sleep(nanoseconds: 3_200_000_000)
                    withAnimation(.easeOut(duration: 0.3)) { self.trouble = nil }
                }
        }
    }

    /// The buttons that belong to whatever is selected — one item, several, or a
    /// region. Lifted out of the main stack: SwiftUI type-checks a view builder
    /// as one expression, and that one had grown past what the compiler will do
    /// in reasonable time.
    @ViewBuilder
    private func selectionChrome(_ geo: GeometryProxy) -> some View {
        if let id = model.selected, let item = model.item(id) {
            itemDelete(item, in: geo.size)
        }
        if model.selectedItems.count > 1 {
            groupMenu(model.selectedItems, in: geo.size)
        }
        if let id = model.selectedRegion,
           let region = model.regions.first(where: { $0.id == id }),
           let box = model.box(of: region) {
            regionButtons(region, box: box, in: geo.size)
        }
    }

    /// What to do with several things at once, offered above them.
    @ViewBuilder
    private func groupMenu(_ ids: Set<UUID>, in size: CGSize) -> some View {
        let boxes = ids.compactMap { model.item($0)?.rect }
        if let box = boxes.dropFirst().reduce(boxes.first) { got, next in got?.union(next) } {
            let at = screenPoint(CGPoint(x: box.midX, y: box.minY), in: size)
            let asking = confirmingGroupDelete
            HStack(spacing: 4) {
                Button("Create region") {
                    model.addRegion(around: ids)
                    confirmingGroupDelete = false
                }
                .font(Theme.chrome(11))
                .buttonStyle(.plain)
                .foregroundStyle(Theme.accent)

                Divider().frame(height: 12)

                Button(asking ? "Sure?" : "Delete") {
                    if asking {
                        model.deleteItems(ids)
                        confirmingGroupDelete = false
                    } else {
                        confirmingGroupDelete = true
                    }
                }
                .font(Theme.chrome(11, weight: asking ? .semibold : .regular))
                .buttonStyle(.plain)
                .foregroundStyle(Theme.danger)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(.background.opacity(0.92))
                    .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
                    .shadow(color: .black.opacity(0.16), radius: 8, y: 2)
            )
            .chrome($overChrome)
            .position(x: at.x, y: at.y - 20)
        }
    }

    /// A region's own three buttons, at its top-right like an item's.
    private func regionButtons(_ region: CanvasRegion, box: CGRect, in size: CGSize) -> some View {
        let corner = screenPoint(CGPoint(x: box.maxX, y: box.minY), in: size)
        let asking = confirmingDelete == region.id

        let info = Button {
            inspecting = inspecting == region.id ? nil : region.id
        } label: {
            Image(systemName: "info")
                .font(.system(size: 8 * buttonScale, weight: .bold))
                .frame(width: 13 * buttonScale, height: 13 * buttonScale)
                .contentShape(Rectangle())
                .foregroundStyle(.white)
                .background(Circle().fill(inspecting == region.id ? Theme.accent : Color.secondary))
        }
        .buttonStyle(.plain)
        .help("Appearance")
        .chrome($overChrome)

        // The discoverable half of "put things in a box". ⌘-dropping does the
        // same thing faster once somebody knows about it; this is how they find
        // out there is anything to know, and it is also the only way to take one
        // thing *out* of a region without deleting it.
        let add = Button {
            addingTo = addingTo == region.id ? nil : region.id
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 8 * buttonScale, weight: .bold))
                .frame(width: 13 * buttonScale, height: 13 * buttonScale)
                .contentShape(Rectangle())
                .foregroundStyle(.white)
                .background(Circle().fill(addingTo == region.id ? Theme.accent : Color.secondary))
        }
        .buttonStyle(.plain)
        .help(addingTo == region.id ? "Click things to add or remove them" : "Add things to this region")
        .chrome($overChrome)

        let remove = Button {
            if asking {
                model.removeRegion(region.id)
                confirmingDelete = nil
                inspecting = nil
            } else {
                confirmingDelete = region.id
            }
        } label: {
            Group {
                if asking {
                    // Scaled, like everything else in this row. It was not, so
                    // a region's confirmation stayed one size while the buttons
                    // beside it grew with the zoom.
                    Text("Sure?")
                        .font(Theme.chrome(10 * buttonScale, weight: .semibold))
                        .padding(.horizontal, 7 * buttonScale)
                        .frame(height: 16 * buttonScale)
                } else {
                    Image(systemName: "xmark")
                        .font(.system(size: 7 * buttonScale, weight: .bold))
                        .frame(width: 13 * buttonScale, height: 13 * buttonScale)
                }
            }
            .contentShape(Rectangle())
            .foregroundStyle(.white)
            .background(Capsule().fill(Theme.danger))
        }
        .buttonStyle(.plain)
        .help(asking ? "Click again — the things inside stay" : "Remove this region")
        .chrome($overChrome)

        return buttonRow(at: corner) {
            info
            add
            remove
        }
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
                .chrome($overChrome)
                .position(at)
                .gesture(
                    // Global, like every other drag here: this handle is drawn
                    // at a position that the drag itself changes.
                    DragGesture(minimumDistance: 0, coordinateSpace: .global)
                        .onChanged { value in
                            let base = bendAtStart ?? link.bend
                            if bendAtStart == nil { bendAtStart = base }
                            let wanted = CGSize(
                                width: base.width + value.translation.width / chrome.zoom,
                                height: base.height + value.translation.height / chrome.zoom
                            )
                            let (snapped, held) = Snap.bend(wanted, tolerance: Snap.reach / chrome.zoom)
                            model.bend(link.id, by: snapped)
                            // The guide for a straightened connector is the
                            // connector: there is nothing else to line it up
                            // with, so the line itself is what changes color.
                            straightened = held
                        }
                        .onEnded { _ in
                            bendAtStart = nil
                            straightened = false
                            model.settled()
                        }
                )

            Button {
                inspecting = inspecting == link.id ? nil : link.id
            } label: {
                Image(systemName: "info")
                    .font(.system(size: 8, weight: .bold))
                    .frame(width: 13, height: 13)
                    .contentShape(Rectangle())
                    .foregroundStyle(.white)
                    .background(Circle().fill(inspecting == link.id ? Theme.accent : Color.secondary))
            }
            .buttonStyle(.plain)
            .help("Appearance")
            .chrome($overChrome)
            .position(x: at.x - 1, y: at.y - 14)

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
            .chrome($overChrome)
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
    private func background(_ geo: GeometryProxy) -> some View {
        let size = geo.size
        ZStack {
            if chrome.grid { grid }
            Color.clear
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    // A box being drawn round things, rather than the canvas
                    // being pulled about. The selector is a mode and this is
                    // what the mode changes: the same drag means something else.
                    if armed == .select {
                        let now = canvasPoint(value.location, in: size)
                        let start = marqueeStart ?? now
                        if marqueeStart == nil { marqueeStart = start }
                        marquee = CGRect(
                            x: min(start.x, now.x), y: min(start.y, now.y),
                            width: abs(now.x - start.x), height: abs(now.y - start.y)
                        )
                        return
                    }
                    // Dragging a region drags what is in it.
                    if let id = draggingRegion {
                        let base = regionOrigin ?? .zero
                        let want = CGSize(width: value.translation.width / chrome.zoom,
                                          height: value.translation.height / chrome.zoom)
                        model.moveRegion(id, by: CGSize(width: want.width - base.width,
                                                        height: want.height - base.height))
                        regionOrigin = want
                        // A region carried onto something joins to it, the same
                        // gesture and the same rule as one card onto another.
                        linkTarget = dropTarget(at: value.location, moving: id, in: geo)
                        return
                    }
                    /*
                     A drag that begins inside a region moves that region,
                     selected or not.

                     It used to require selecting it first, which made the
                     gesture two gestures and made it feel unreliable rather
                     than deliberate — a press that did nothing, followed by one
                     that worked, with nothing to say why.

                     Waiting for actual movement is what keeps a plain click
                     working: below the threshold this falls through, and the
                     click handler on release selects the region the ordinary
                     way. It is also why the pan branch below cannot have
                     started — the first frame that has moved far enough is this
                     one, and it returns.

                     What it costs: dragging the canvas by a region's empty
                     space no longer pans. Two-finger scroll still does, and so
                     does dragging anywhere that is not inside a region.
                     */
                    let far = abs(value.translation.width) > 3 || abs(value.translation.height) > 3
                    if draggingRegion == nil, far, !dragging, marquee == nil,
                       let region = model.region(at: canvasPoint(value.startLocation, in: size)) {
                        draggingRegion = region.id
                        regionOrigin = .zero
                        model.select(region: region.id)
                        return
                    }
                    pressing = true
                    // A press is not yet a drag. Below this it is somebody
                    // clicking and the pointer says so; past it they are pulling
                    // the canvas and it becomes a fist.
                    if abs(value.translation.width) > 3 || abs(value.translation.height) > 3 {
                        dragging = true
                    }
                    // A button going down is not a pointer moving, so the hover
                    // above will not have run. Without this the hand does not
                    // close until the drag has already traveled a few points.
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
                    if armed == .select {
                        // Everything the box touches. Touching rather than
                        // wholly containing, because a box drawn round a group
                        // is drawn round roughly a group, and leaving out the
                        // one card whose corner stuck out is not what anybody
                        // meant by it.
                        if let box = marquee, box.width > 2 || box.height > 2 {
                            model.select(items: Set(
                                model.items.filter { $0.rect.intersects(box) }.map(\.id)
                            ))
                        }
                        marquee = nil
                        marqueeStart = nil
                        // Off after one use. A mode that stays on is a mode
                        // somebody forgets is on, and the next ordinary drag
                        // draws a box instead of moving the canvas.
                        armed = nil
                        return
                    }
                    if let id = draggingRegion {
                        if let onto = linkTarget, let traveled = regionOrigin {
                            // Back where it came from, and a line left behind.
                            // Exactly what dropping one card on another does,
                            // and it has to be exactly that or the two gestures
                            // would mean different things by the same motion.
                            model.moveRegion(id, by: CGSize(width: -traveled.width, height: -traveled.height))
                            model.link(from: id, to: onto)
                            model.clearSelection()
                        } else {
                            model.settled()
                        }
                        draggingRegion = nil
                        regionOrigin = nil
                        linkTarget = nil
                        return
                    }
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
                        let here = canvasPoint(value.location, in: size)
                        if let link = hitLink(at: value.location, in: size) {
                            model.select(link: link)
                        } else if let region = model.region(at: here) {
                            // Only where no item is — the inside of a region is
                            // mostly the things it holds, and clicking one of
                            // those means the thing, not the box round it.
                            //
                            // And the empty part of a region is not empty
                            // canvas. It is the region: a box drawn round
                            // things has an inside, and clicking the inside is
                            // how you get hold of the box.
                            model.select(region: region.id)
                        } else {
                            // Nothing here. The comment above this block has
                            // always said a click on the background drops the
                            // selection and the code never did it — there was
                            // no `else`, so a click on bare canvas hit none of
                            // the branches and quietly left whatever was
                            // selected selected.
                            model.clearSelection()
                            inspecting = nil
                        }
                        confirmingDelete = nil
                        confirmingGroupDelete = false
                        clearStep = 0
                        addingTo = nil
                        fileMenuOpen = false
                        confirmingFile = nil
                        // A click anywhere else closes it, which is what a menu
                        // does and what somebody who opened it by accident will
                        // try first. A picture nobody chose is abandoned the
                        // same way.
                        openMenu = nil
                        askingImage = nil
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
        let selected = model.selectedItems.contains(item.id)

        CanvasItemView(
            item: item,
            zoom: chrome.zoom,
            hovered: model.hovered == item.id,
            selected: selected,
            editing: editing,
            dropTarget: linkTarget == item.id,
            inRegion: addingTo.map { model.isMember(item.id, of: $0) },
            badge: badge(for: item),
            picture: pictures[item.id],
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
                    let wanted = CGPoint(x: from.x + value.translation.width / chrome.zoom,
                                         y: from.y + value.translation.height / chrome.zoom)
                    // Where it wants to be, then where it should be. The
                    // tolerance is converted from screen points so a snap feels
                    // the same at every zoom rather than becoming a magnet at 6x
                    // and unreachable at 0.15x.
                    let snapped = Snap.move(
                        CGRect(origin: wanted, size: CGSize(width: item.w, height: item.h)),
                        others: model.items.filter { $0.id != item.id }.map(\.rect),
                        grid: chrome.grid ? 24 : nil,
                        tolerance: Snap.reach / chrome.zoom
                    )
                    guides = snapped.guides
                    model.move(item.id, to: snapped.rect.origin)
                    // What the pointer is over, not what the box overlaps. A
                    // box being dragged overlaps whatever it happens to cross,
                    // and half of that is the diagram it is being carried
                    // across; the pointer is the one part of the gesture that
                    // is unambiguously aimed.
                    linkTarget = dropTarget(at: local(value.location, geo), moving: item.id, in: geo)
                    // Read every frame rather than once, because it is a key
                    // somebody presses partway through a drag, once they can see
                    // what the drop is about to do.
                    joining = NSEvent.modifierFlags.contains(.command)
                }
                .onEnded { value in
                    let moved = abs(value.translation.width) > 3 || abs(value.translation.height) > 3
                    if moved, let onto = linkTarget, joining,
                       model.regions.contains(where: { $0.id == onto }) {
                        // ⌘ and only ⌘. A plain drop onto a region connects to
                        // it, like a drop onto anything else — one gesture, one
                        // meaning. Held down, it means into the box instead: the
                        // card stays where it was let go and the region grows to
                        // include it, which it does by itself, because the box
                        // is the extent of what it holds.
                        model.join(region: onto, item: item.id)
                        model.settled()
                    } else if moved, let onto = linkTarget, let from = moveOrigin {
                        // Dropped on something. The gesture said "this one goes
                        // with that one", not "this one goes here", so the box
                        // goes back where it came from and a line is what is
                        // left behind. Leaving it where it landed would mean
                        // every connection also rearranged the diagram.
                        model.move(item.id, to: from)
                        model.link(from: item.id, to: onto)
                        model.clearSelection()
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
                        // In add-mode, a click means in-or-out rather than
                        // select. The region stays selected throughout, so the
                        // box and its buttons stay where they were and the mode
                        // is visibly still on.
                        if let region = addingTo {
                            // Refusing silently is indistinguishable from a
                            // click that did not register.
                            if model.isLastMember(item.id, of: region) {
                                trouble = "A region has to hold something — remove the region instead"
                            } else {
                                model.toggle(region: region, item: item.id)
                            }
                            movingId = nil
                            moveOrigin = nil
                            return
                        }
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
                            // Selecting something else drops a question asked
                            // about the last one.
                            if confirmingDelete != item.id { confirmingDelete = nil }
                            model.select(item: item.id)
                        }
                    }
                    movingId = nil
                    moveOrigin = nil
                    linkTarget = nil
                    joining = false
                    guides = []
                }
        )

        .overlay {
            // Grips only when it is the one thing selected. Six boxes with
            // twenty-four corners between them is not a control, and a resize
            // that meant "all of these" is a different feature nobody asked for.
            if model.selected == item.id { handles(item) }
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
                .chrome($overChrome)
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
                            let wanted = start.corner.applied(to: start.from, by: delta)
                            let snapped = Snap.resize(
                                wanted,
                                movingMinX: start.corner == .topLeading || start.corner == .bottomLeading,
                                movingMinY: start.corner == .topLeading || start.corner == .topTrailing,
                                others: model.items.filter { $0.id != item.id }.map(\.rect),
                                grid: chrome.grid ? 24 : nil,
                                tolerance: Snap.reach / chrome.zoom
                            )
                            guides = snapped.guides
                            model.resize(item.id, to: snapped.rect)
                        }
                        .onEnded { _ in
                            resizing = nil
                            guides = []
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
            // information — better to draw nothing than a gray field.
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
