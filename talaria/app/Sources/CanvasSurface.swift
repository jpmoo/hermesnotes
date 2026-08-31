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
struct CanvasItem: Identifiable, Equatable {
    let id: UUID
    var x: CGFloat
    var y: CGFloat
    var w: CGFloat
    var h: CGFloat
    var text: String

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
    func load() -> [CanvasItem]
    func save(_ items: [CanvasItem])
}

/**
 The canvas, for as long as the app is running.

 Not a placeholder to be embarrassed about: the desk deliberately forgets where
 it was across a reboot, and until this is wired to something durable a canvas
 that survived a restart would be the only part of the desk that did. It matches
 what everything around it promises.
 */
final class MemoryCanvasStore: CanvasStore {
    private var items: [CanvasItem] = []
    func load() -> [CanvasItem] { items }
    func save(_ items: [CanvasItem]) { self.items = items }
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

    init(store: CanvasStore = MemoryCanvasStore()) {
        self.store = store
        items = store.load()
    }

    private func persist() { store.save(items) }

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
    func addText(at point: CGPoint) {
        let size = Self.newItemSize
        let item = CanvasItem(
            id: UUID(),
            x: point.x - size.width / 2,
            y: point.y - size.height / 2,
            w: size.width,
            h: size.height,
            text: ""
        )
        items.append(item)
        selected = nil
        draft = ""
        editing = item.id
        // Not persisted yet. An item with no words in it is a gesture in
        // progress, not a thing somebody made.
    }

    /// Start editing something already there.
    func beginEditing(_ id: UUID) {
        guard let item = items.first(where: { $0.id == id }) else { return }
        selected = nil
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
     */
    func commitEdit() {
        guard let id = editing else { return }
        editing = nil
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            items.removeAll { $0.id == id }
            draft = ""
            persist()
            return
        }
        if let at = items.firstIndex(where: { $0.id == id }) {
            items[at].text = draft
        }
        draft = ""
        persist()
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
        if selected == id { selected = nil }
        if editing == id { editing = nil }
        persist()
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
private struct CanvasToolStrip: View {
    /// Which tool is being dragged, and where the pointer is, in the surface's
    /// own coordinates. Held by the surface because the ghost is drawn there —
    /// over the canvas, which this strip is not.
    @Binding var dragging: CanvasTool?
    @Binding var dragPoint: CGPoint?
    let drop: (CanvasTool, CGPoint) -> Void

    var body: some View {
        VStack(spacing: 6) {
            ForEach(CanvasTool.allCases) { tool in
                VStack(spacing: 2) {
                    Image(systemName: tool.symbol)
                        .font(.system(size: 15, weight: .medium))
                    Text(tool.name)
                        .font(Theme.chrome(9, weight: .medium))
                }
                .frame(width: 44, height: 40)
                .contentShape(Rectangle())
                .foregroundStyle(dragging == tool ? Theme.accent : Color.secondary)
                .background(
                    RoundedRectangle(cornerRadius: 7)
                        .fill(dragging == tool ? Color.primary.opacity(0.08) : .clear)
                )
                .help(tool.hint)
                .gesture(
                    DragGesture(minimumDistance: 0, coordinateSpace: .named(CanvasSurface.space))
                        .onChanged { value in
                            dragging = tool
                            dragPoint = value.location
                        }
                        .onEnded { value in
                            dragging = nil
                            dragPoint = nil
                            drop(tool, value.location)
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
    @Binding var draft: String
    let commit: () -> Void

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
        ZStack(alignment: .topLeading) {
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
                    .onAppear { focused = true }
                    // Losing focus is "clicking away", which commits by the same
                    // rule as Return. Both are somebody saying they are done;
                    // neither is somebody saying to throw it away.
                    .onChange(of: focused) { now in if !now { commit() } }
            } else {
                Text(item.text)
                    .font(.system(size: 12))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(width: item.w, height: item.h, alignment: .topLeading)
        // The whole box answers the pointer, not just the letters. A label with
        // one short word in a wide box would otherwise be nearly unhittable, and
        // "touching an item highlights it" would be a lie most of the time.
        .contentShape(Rectangle())
        .overlay {
            // Hover is the faintest thing that can be seen; selection is
            // definite. They are the same rectangle at two strengths rather than
            // two different marks, because they are two stages of one idea.
            if editing {
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

    /// Where the pan was when the current drag began. A drag reports its total
    /// translation, not an increment, so without this every frame re-applies
    /// the whole gesture from the origin and the canvas leaps.
    @State private var panAtStart: CGSize?
    @State private var zoomAtStart: CGFloat?
    @State private var pressing = false
    @State private var dragging = false
    /// Where the pointer is, for zooming about it rather than about the middle.
    @State private var hover: CGPoint?

    @State private var tool: CanvasTool?
    @State private var toolPoint: CGPoint?

    /// The item being moved, and where it started. Same reasoning as `panAtStart`.
    @State private var movingId: UUID?
    @State private var moveOrigin: CGPoint?
    @State private var resizing: (id: UUID, corner: CanvasItemView.Corner, from: CGRect)?

    /// Open over the canvas, pointing the instant a button goes down, closed
    /// once that press starts pulling the canvas about.
    private var cursor: NSCursor {
        if tool != nil { return .crosshair }
        if dragging { return .closedHand }
        if pressing { return .pointingHand }
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

                content(geo.size)

                // The ghost. Drawn over everything, because a tool being carried
                // is not on the canvas yet and should not look as though it is.
                if let tool, let at = toolPoint {
                    Image(systemName: tool.symbol)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .padding(6)
                        .background(Circle().fill(.background.opacity(0.8)))
                        .position(at)
                        .allowsHitTesting(false)
                }

                CursorArea(cursor: cursor).allowsHitTesting(false)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .coordinateSpace(name: Self.space)
            .overlay(alignment: .trailing) {
                CanvasToolStrip(dragging: $tool, dragPoint: $toolPoint) { which, at in
                    switch which {
                    case .text:
                        // Ignore a drop that never left the strip: that is a
                        // click on a tool, and a click has nowhere to put one.
                        guard at.x < geo.size.width - 60 else { return }
                        model.addText(at: canvasPoint(at, in: geo.size))
                    }
                }
                .padding(.trailing, 10)
            }
        }
    }

    // MARK: Coordinates

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
        .onContinuousHover { phase in
            switch phase {
            case .active(let point): hover = point
            // Off the canvas entirely. The last known point would be an edge,
            // and zooming about an edge with the pointer somewhere else is
            // worse than zooming about the middle.
            case .ended: hover = nil
            @unknown default: hover = nil
            }
        }
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
                    guard dragging else { return }
                    let base = panAtStart ?? chrome.pan
                    if panAtStart == nil { panAtStart = base }
                    chrome.pan = CGSize(width: base.width + value.translation.width,
                                        height: base.height + value.translation.height)
                }
                .onEnded { _ in
                    // A press on the background that never became a drag is
                    // "clicking away": it finishes whatever was being typed and
                    // drops the selection. This is the other half of the rule
                    // that an empty item disappears.
                    if !dragging {
                        model.commitEdit()
                        model.selected = nil
                    }
                    panAtStart = nil
                    pressing = false
                    dragging = false
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
    private func content(_ size: CGSize) -> some View {
        ZStack {
            ForEach(model.items) { item in
                itemView(item, in: size)
            }
        }
        .scaleEffect(chrome.zoom)
        .offset(chrome.pan)
    }

    @ViewBuilder
    private func itemView(_ item: CanvasItem, in size: CGSize) -> some View {
        let editing = model.editing == item.id
        let selected = model.selected == item.id

        CanvasItemView(
            item: item,
            zoom: chrome.zoom,
            hovered: model.hovered == item.id,
            selected: selected,
            editing: editing,
            draft: $model.draft,
            commit: { model.commitEdit() }
        )
        .onHover { inside in
            if inside { model.hovered = item.id }
            else if model.hovered == item.id { model.hovered = nil }
        }
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    guard !editing else { return }
                    if movingId == nil {
                        movingId = item.id
                        moveOrigin = CGPoint(x: item.x, y: item.y)
                    }
                    guard let from = moveOrigin else { return }
                    // The translation is in screen points and the item lives in
                    // canvas points, so it is divided by the zoom. Without this
                    // an item dragged at 4× runs four times as far as the
                    // pointer, which reads as the canvas being broken.
                    model.move(
                        item.id,
                        to: CGPoint(x: from.x + value.translation.width / chrome.zoom,
                                    y: from.y + value.translation.height / chrome.zoom)
                    )
                }
                .onEnded { value in
                    let moved = abs(value.translation.width) > 3 || abs(value.translation.height) > 3
                    if moved {
                        model.settled()
                    } else if !editing {
                        // A press that went nowhere is a click, and a click
                        // selects. Anything being typed into elsewhere is
                        // finished first — clicking on another item is clicking
                        // away from this one.
                        model.commitEdit()
                        model.selected = item.id
                    }
                    movingId = nil
                    moveOrigin = nil
                }
        )
        // Two clicks to edit something already written. Not something anybody
        // asked for and not something anybody has to be told: it is what a
        // double click means everywhere else, and without it a typo is a
        // deletion and a retype.
        //
        // `simultaneousGesture`, because the drag above starts at zero distance
        // and a plain `onTapGesture` loses every race with it — the tap is
        // recognised only if the drag never claims the sequence, and a drag
        // that begins on the first press always does.
        .simultaneousGesture(TapGesture(count: 2).onEnded { model.beginEditing(item.id) })
        .overlay {
            if selected { handles(item) }
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
                    DragGesture(minimumDistance: 0)
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
