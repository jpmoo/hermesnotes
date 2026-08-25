import SwiftUI
import UniformTypeIdentifiers

/// A matrix collection, in a popover.
///
/// This is the thing a widget could not be. A widget renders a snapshot and
/// accepts taps; a matrix is a board you rearrange, and dragging a card between
/// quadrants is most of what it is for. A popover is a real window, so it can
/// drag, scroll and hover — and it reaches the daemon socket directly, with no
/// sandbox, no App Group and no entitlement to argue about.
@MainActor
final class BoardModel: ObservableObject {
    @Published var boards: [Daemon.BoardSummary] = []
    @Published var selected: String?
    @Published var board: Daemon.Board?
    @Published var freshness = "fresh"
    @Published var note = ""
    @Published var error: String?
    @Published var busy = false

    /// The agenda has its own state — types shown, feed staleness — and is
    /// only ever drawn for a calendar collection.
    let agenda = AgendaModel()

    private let lastBoardKey = "talaria.lastBoard"

    func load() {
        busy = true
        Task.detached(priority: .userInitiated) { [self] in
            do {
                let list = try Daemon.boards()
                let pick = await MainActor.run { () -> String? in
                    self.boards = list
                    let remembered = UserDefaults.standard.string(forKey: self.lastBoardKey)
                    let chosen = self.selected
                        ?? (remembered.flatMap { r in list.contains { $0.id == r } ? r : nil })
                        ?? list.first?.id
                    self.selected = chosen
                    return chosen
                }
                guard let pick else {
                    await MainActor.run {
                        self.busy = false
                        self.error = "No matrix collections in the mirror."
                    }
                    return
                }
                let got = try Daemon.board(pick)
                await MainActor.run {
                    self.board = got.board
                    self.freshness = got.freshness
                    self.note = got.note
                    self.error = nil
                    self.busy = false
                    self.loadShutGroups()
                }
            } catch {
                await MainActor.run { self.error = "\(error)"; self.busy = false }
            }
        }
    }

    /// Everywhere a card can be dragged from.
    var allCards: [Daemon.Card] {
        guard let b = board else { return [] }
        return b.cells.values.flatMap { $0 } + b.drawer
    }

    /// Which group headings are shut, per collection and remembered — a board
    /// you have to re-collapse every time you open it is one you stop
    /// collapsing. Shut rather than open, so a heading nobody has touched
    /// starts open.
    @Published private var shutGroups: Set<String> = []

    private var shutKey: String { "talaria.groups.\(selected ?? "x")" }

    func isShut(_ label: String) -> Bool { shutGroups.contains(label) }

    func toggleGroup(_ label: String) {
        if shutGroups.contains(label) { shutGroups.remove(label) } else { shutGroups.insert(label) }
        UserDefaults.standard.set(Array(shutGroups), forKey: shutKey)
    }

    private func loadShutGroups() {
        shutGroups = Set(UserDefaults.standard.stringArray(forKey: shutKey) ?? [])
    }

    func choose(_ id: String) {
        selected = id
        UserDefaults.standard.set(id, forKey: lastBoardKey)
        loadShutGroups()
        load()
    }

    /// Optimistic: the daemon writes the move into the mirror before answering,
    /// so reloading shows the card where it was dropped whether or not Hermes
    /// was reachable.
    /// `region` of nil puts it back in the drawer.
    func move(_ card: Daemon.Card, to region: Int?) {
        guard let boardId = board?.id else { return }
        Task.detached(priority: .userInitiated) { [self] in
            do {
                try Daemon.write([
                    "kind": "move", "collectionId": boardId, "blockId": card.id,
                    "region": region as Any? ?? NSNull(),
                ])
            } catch {
                await MainActor.run { self.error = "\(error)" }
            }
            await MainActor.run { self.load() }
        }
    }

    func complete(_ card: Daemon.Card) {
        Task.detached(priority: .userInitiated) { [self] in
            do {
                try Daemon.write(["kind": "complete", "blockId": card.id])
            } catch {
                await MainActor.run { self.error = "\(error)" }
            }
            await MainActor.run { self.load() }
        }
    }
}

/// Accepting a dropped card.
///
/// `onDrop`/`onDrag` rather than `dropDestination`/`draggable`: the newer pair
/// competes with the tap gesture on a card for the same press, and on macOS the
/// tap wins — so the drag never began and nothing anywhere said why.
private func acceptDrop(_ providers: [NSItemProvider], into region: Int?, model: BoardModel) -> Bool {
    guard let provider = providers.first else { return false }
    provider.loadObject(ofClass: NSString.self) { object, _ in
        guard let id = object as? String else { return }
        Task { @MainActor in
            guard let card = model.allCards.first(where: { $0.id == id }) else { return }
            model.move(card, to: region)
        }
    }
    return true
}

struct BoardView: View {
    @ObservedObject var model: BoardModel
    /// A board left open is a photograph unless something says the mirror moved.
    @State private var watch: MirrorWatch?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let board = model.board {
                if board.kind == "calendar" {
                    AgendaView(model: model.agenda, collectionURL: board.url)
                } else if board.table, !board.columns.isEmpty {
                    table(board)
                } else if board.rollup {
                    rollup(board.groups)
                } else if board.canvas {
                    CanvasBoard(board: board, model: model)
                } else if board.gridded {
                    grid(board)
                    // Always drawn, even with nothing in it. Hiding it when
                    // empty took the drop target away at exactly the moment it
                    // was needed — there was nowhere to put the first card you
                    // wanted out of the grid.
                    Divider()
                    drawer(board.drawer).frame(height: board.drawer.isEmpty ? 52 : 88)
                } else {
                    sequence(board.members)
                }
            } else if let error = model.error {
                message(error, systemImage: "exclamationmark.triangle")
            } else {
                message("Loading…", systemImage: "clock")
            }
            if model.freshness != "fresh" {
                Divider()
                Text(model.note)
                    .font(.caption)
                    .foregroundStyle(model.freshness == "cold" || model.freshness == "never" ? .orange : .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).padding(.vertical, 6)
            }
        }
        // A board left open showed whatever the mirror held when it was opened,
        // with nothing to say the picture had aged. That reads as Talaria having
        // stopped syncing, and the sync is usually fine — the window simply
        // never asked again.
        .onAppear {
            let w = MirrorWatch { model.load() }
            w.start()
            watch = w
        }
        .onDisappear {
            watch?.stop()
            watch = nil
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            // Always a picker, even with one board: which collection this is
            // showing is a thing to be able to see, not only to change.
            Picker("", selection: Binding(
                get: { model.selected ?? "" },
                set: { model.choose($0) }
            )) {
                ForEach(model.boards, id: \.id) { b in
                    // Kind and name together: several collections can share a
                    // name across shapes, and which shape it is changes what
                    // you are about to be shown.
                    Label {
                        Text("\(b.title)  ·  \(b.kind ?? "collection")")
                    } icon: {
                        Image(systemName: Theme.symbol(forCollection: b.kind))
                    }
                    .tag(b.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 300)
            .disabled(model.boards.count < 2)
            Spacer()
            if model.busy { ProgressView().controlSize(.small) }
            // A panel shows what it can show. Everything else this collection
            // is — editing, the views it has that this doesn't — is one click
            // away rather than absent.
            if let url = model.board?.url, let target = URL(string: url) {
                Button { Opener.open(target) } label: {
                    Image(systemName: "arrow.up.forward.app")
                }
                .buttonStyle(.borderless)
                .help("Open this collection in Hermes")
            }
            Button {
                model.load()
                // Reloading by hand is also "I have seen it": without this the
                // watcher would notice the same move a moment later and do it again.
                watch?.markSeen()
            } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .help("Refresh from the mirror")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func message(_ text: String, systemImage: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage).font(.title2).foregroundStyle(.secondary)
            Text(text).font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Buckets in first-seen order, so grouping rearranges nothing that was
    /// already ordered. A block the grouping field says nothing about goes last
    /// under its own heading rather than being dropped or silently first.
    private func grouped<T>(_ items: [T], by key: (T) -> String?) -> [(String, [T])] {
        var order: [String] = []
        var buckets: [String: [T]] = [:]
        for item in items {
            let k = key(item) ?? "—"
            if buckets[k] == nil { order.append(k); buckets[k] = [] }
            buckets[k]?.append(item)
        }
        if let i = order.firstIndex(of: "—") {
            order.remove(at: i)
            order.append("—")
        }
        return order.map { ($0, buckets[$0] ?? []) }
    }

    private func groupHeading(_ label: String, count: Int) -> some View {
        let shut = model.isShut(label)
        return HStack(spacing: 6) {
            Image(systemName: shut ? "chevron.right" : "chevron.down")
                .font(.system(size: 9)).foregroundStyle(.secondary)
            Text(label == "—" ? "Ungrouped" : label)
                .font(Theme.chrome(10, weight: .semibold))
                .foregroundStyle(Theme.accentInk)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Capsule().fill(Theme.accent.opacity(0.18)))
            Text("\(count)")
                .font(Theme.chrome(9.5)).foregroundStyle(.secondary)
            Rectangle().fill(Color.secondary.opacity(0.18)).frame(height: 0.5)
        }
        .padding(.top, 4)
        .contentShape(Rectangle())
        .onTapGesture { model.toggleGroup(label) }
    }

    /// A table, with the columns it was configured with.
    ///
    /// Drawn as a list of titles it stopped being a table — the columns are the
    /// whole point of choosing that shape for a collection.
    private func table(_ board: Daemon.Board) -> some View {
        GeometryReader { geo in
            // Fills the width, keeping whatever proportions were set in the web
            // app. A fixed pixel width there means nothing here — the panel is
            // not the browser — but the relative sizes are a real choice and
            // worth carrying across.
            // Room for the scroller, which overlays the content on a trackpad
            // and takes space from it on a mouse.
            let widths = columnWidths(board, available: geo.size.width - 16)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 0) {
                        ForEach(Array(board.columns.enumerated()), id: \.element.key) { i, column in
                            Text(column.label)
                                .font(Theme.chrome(10, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                // Padding first, then the frame: the other way
                                // round the padding is added *outside* the
                                // width, so every column is twelve points wider
                                // than it was measured to be and the last one
                                // falls off the edge.
                                .padding(.vertical, 5).padding(.horizontal, 6)
                                .frame(width: widths[i], alignment: .leading)
                        }
                    }
                    .background(Rectangle().fill(Color.primary.opacity(0.09)))

                    ForEach(Array(board.tableRows.enumerated()), id: \.element.id) { r, row in
                        HStack(spacing: 0) {
                            ForEach(Array(board.columns.enumerated()), id: \.element.key) { i, column in
                                Text(row.cells[column.key] ?? "")
                                    .font(Theme.body(11))
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                    .padding(.vertical, 4).padding(.horizontal, 6)
                                    .frame(width: widths[i], alignment: .leading)
                            }
                        }
                        // Banded, because a wide row is hard to follow across
                        // without something to hold the eye on the line — as a
                        // tint of the text rather than a surface colour, which
                        // is what a control is painted with.
                        .background(r.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.06))
                        .contentShape(Rectangle())
                        .onTapGesture {
                            if let card = model.allCards.first(where: { $0.id == row.id }),
                               let u = URL(string: card.url) { Opener.open(u) }
                        }
                    }
                }
            }
        }
    }

    /// Each column's share of the room available.
    ///
    /// A column nobody has resized has no stored width, so it is given a
    /// sensible one to be proportional *with* — otherwise it would collapse to
    /// nothing beside the columns that do have one.
    private func columnWidths(_ board: Daemon.Board, available: CGFloat) -> [CGFloat] {
        let weights = board.columns.map { column -> CGFloat in
            if let w = column.width, w > 0 { return CGFloat(w) }
            return column.key == "title" ? 260 : 130
        }
        let total = weights.reduce(0, +)
        guard total > 0, available > 0 else { return weights }
        // A floor, so a narrow panel doesn't squeeze a column into a sliver;
        // the horizontal scroll picks up the overflow when that happens.
        let scaled = weights.map { max(64, available * $0 / total) }
        return scaled
    }

    /// Everything that isn't a grid or a canvas: a list, in its own order.
    ///
    /// Deliberately one renderer rather than five near-misses. A table, a
    /// masonry and a rollup differ in the web app in ways that matter there and
    /// would be a poor imitation here; what they have in common is a sequence of
    /// blocks, which is the useful part at this size.
    private func sequence(_ cards: [Daemon.Card]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if model.board?.groupBy != nil {
                    ForEach(grouped(cards, by: { $0.group }), id: \.0) { label, items in
                        groupHeading(label, count: items.count)
                        if !model.isShut(label) {
                            ForEach(items) { card in CardRow(card: card, model: model) }
                        }
                    }
                } else {
                    ForEach(cards) { card in CardRow(card: card, model: model) }
                }
                if cards.isEmpty {
                    Text("Nothing in this collection")
                        .font(Theme.body(11)).foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity).padding(.vertical, 20)
                }
            }
            .padding(10)
        }
    }

    /// A rollup: a heading per bucket, with whatever hangs under it, however
    /// many levels deep that goes.
    private func rollup(_ groups: [Daemon.Group]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if model.board?.groupBy != nil {
                    ForEach(grouped(groups, by: { $0.group }), id: \.0) { label, buckets in
                        groupHeading(label, count: buckets.count)
                        if !model.isShut(label) {
                            ForEach(buckets) { group in
                                RollupNode(node: group, depth: 0, model: model)
                            }
                        }
                    }
                } else {
                    ForEach(groups) { group in
                        RollupNode(node: group, depth: 0, model: model)
                    }
                }
                if groups.isEmpty {
                    Text("Nothing rolls up here")
                        .font(Theme.body(11)).foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity).padding(.vertical, 20)
                }
            }
            .padding(10)
        }
    }

    private func grid(_ board: Daemon.Board) -> some View {
        GeometryReader { geo in
            // Every region the same size, as on the web. Letting a cell grow
            // with its contents makes the quadrant with the most work in it the
            // biggest, which is backwards: the grid is supposed to say where
            // things are, and it can only do that if the cells stay put.
            let gap: CGFloat = 8
            let cellW = (geo.size.width - gap * CGFloat(board.cols + 1)) / CGFloat(board.cols)
            let cellH = (geo.size.height - gap * CGFloat(board.rows + 1)) / CGFloat(board.rows)
            VStack(spacing: gap) {
                ForEach(0..<board.rows, id: \.self) { r in
                    HStack(spacing: gap) {
                        ForEach(0..<board.cols, id: \.self) { c in
                            let i = r * board.cols + c
                            if let region = board.regions.first(where: { $0.index == i }) {
                                cell(region, cards: board.cells[String(i)] ?? [])
                                    .frame(width: cellW, height: cellH)
                            }
                        }
                    }
                }
            }
            .padding(gap)
        }
    }

    /// Matched by the query, not yet placed. Drag from here into a region.
    private func drawer(_ cards: [Daemon.Card]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(cards.isEmpty ? "Unplaced" : "Unplaced — \(cards.count)")
                .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                .padding(.horizontal, 10)
            if cards.isEmpty {
                Text("Drag a card here to take it off the board")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(cards) { card in
                            CardRow(card: card, model: model)
                                .frame(width: 190)
                                .background(RoundedRectangle(cornerRadius: 5).fill(.quaternary.opacity(0.4)))
                        }
                    }
                    .padding(.horizontal, 10)
                }
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.quaternary.opacity(0.2))
        // Without this an empty strip is mostly transparent space, and a drop
        // lands on whatever is behind it rather than on the drawer.
        .contentShape(Rectangle())
        // Dropping here takes a card out of the grid without taking it out of
        // the collection — the way back from a region, which otherwise had none.
        .onDrop(of: [.text], isTargeted: nil) { providers in
            acceptDrop(providers, into: nil, model: model)
        }
    }

    private func cell(_ region: Daemon.Region, cards: [Daemon.Card]) -> some View {
        let tint = region.color.flatMap { Color(hex: $0) }
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                // The region's colour as a bar rather than a wash: a card has to
                // stay readable on top, and a full-strength tint behind small
                // text is what made this look like a toy.
                Capsule().fill(tint ?? Theme.accent).frame(width: 3, height: 11)
                Text(region.title).font(Theme.chrome(11, weight: .semibold))
                Spacer()
                Text("\(cards.count)")
                    .font(Theme.chrome(10)).foregroundStyle(.secondary)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.secondary.opacity(0.13)))
            }
            .padding(.horizontal, 9).padding(.top, 7)

            ScrollView(showsIndicators: true) {
                VStack(spacing: 3) {
                    ForEach(cards) { card in CardRow(card: card, model: model, tint: tint) }
                    if cards.isEmpty {
                        Text("Drop here").font(.caption2).foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity).padding(.vertical, 8)
                    }
                }
                .padding(.horizontal, 6).padding(.bottom, 6)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: Theme.cardRadius)
                // Hermes stores these with alpha already — around 0.8 — so a
                // further 0.07 on top left barely a tint at all. The cards
                // sitting on it carry their own opaque background, so the
                // region can be the colour it was chosen to be.
                .fill((tint ?? Color.secondary).opacity(0.45))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cardRadius)
                .strokeBorder((tint ?? Color.secondary).opacity(0.9), lineWidth: 1)
        )
        .onDrop(of: [.text], isTargeted: nil) { providers in
            acceptDrop(providers, into: region.index, model: model)
        }
    }
}

private struct CardRow: View {
    let card: Daemon.Card
    @ObservedObject var model: BoardModel
    /// The region's colour, when the card is sitting in one. A card takes a
    /// shade of its region rather than being a white box on a coloured field —
    /// which is what makes a card read as belonging to the quadrant it is in
    /// rather than as something dropped on top of it.
    var tint: Color? = nil
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            if card.canComplete {
                Button { model.complete(card) } label: {
                    Image(systemName: card.done ? "checkmark.square.fill" : "square")
                        .font(.system(size: 12))
                        .foregroundStyle(card.done ? Theme.accent : .secondary)
                }
                .buttonStyle(.borderless)
                .help(card.done ? "Already done" : "Mark complete")
                .disabled(card.done)
            } else {
                // No status to set — a checkbox here would offer nonsense.
                Image(systemName: Theme.symbol(forTool: card.typeName))
                    .font(.system(size: 11)).foregroundStyle(.tertiary)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(Theme.body(11.5))
                    .strikethrough(card.done)
                    .foregroundStyle(card.done ? .secondary : .primary)
                    .lineLimit(2)
                // The card's dates, in full, the way the web app shows them —
                // a range where there is one, rather than only its far end.
                // Tags are left off: on a matrix they are mostly the region's
                // own tag, so a card sitting in Do captioned "#do" is the board
                // repeating itself.
                if let bits = card.dates, !bits.isEmpty {
                    HStack(spacing: 5) {
                        ForEach(bits, id: \.self) { bit in
                            Text(bit.text)
                                .font(Theme.chrome(9.5))
                                .foregroundStyle(bit.overdue ? AnyShapeStyle(Theme.danger) : AnyShapeStyle(.secondary))
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5).padding(.horizontal, 7)
        .background(
            // Opaque underneath, so text stays readable whatever the region's
            // colour is, with a wash of that colour over it.
            RoundedRectangle(cornerRadius: Theme.controlRadius)
                .fill(.background)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.controlRadius)
                        .fill((tint ?? Theme.accent).opacity(hovering ? 0.34 : 0.18))
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.controlRadius)
                .strokeBorder((tint ?? Theme.accent).opacity(hovering ? 0.75 : 0.35), lineWidth: 0.5)
        )
        .onHover { hovering = $0 }
        .contentShape(Rectangle())
        // onDrag before the tap, so a press that turns into a drag is a drag.
        // The other order gives the tap first refusal and it takes it.
        .onDrag {
            NSItemProvider(object: card.id as NSString)
        } preview: {
            Text(card.title).font(.caption).lineLimit(1).padding(6)
                .background(RoundedRectangle(cornerRadius: 5).fill(.thinMaterial))
        }
        .onTapGesture { if let u = URL(string: card.url) { Opener.open(u) } }
    }
}

/// A canvas, read-only.
///
/// Members sit at the coordinates the web app placed them at, with the
/// collection's own sticky notes and the connections between blocks. Pan and
/// zoom, and click a card to open it — but nothing is moved from here: a canvas
/// is a spatial argument someone made deliberately, and nudging it by accident
/// from a small window would be a poor trade for a convenience nobody asked for.
struct CanvasBoard: View {
    let board: Daemon.Board
    @ObservedObject var model: BoardModel
    @State private var scale: CGFloat = 0.75
    @State private var pinchStart: CGFloat = 0.75
    @State private var offset: CGSize = .zero
    @State private var dragged: CGSize = .zero
    @State private var cursor: CGPoint?
    @StateObject private var scrollPanBox = ScrollPanBox()
    private var scrollPan: ScrollPan { scrollPanBox.pan }
    @AppStorage("talaria.canvas.dots") private var showDots = true

    var body: some View {
        GeometryReader { geo in
            ZStack {
                if showDots { dotGrid(in: geo.size) }
                canvasContent
                    .scaleEffect(scale, anchor: .center)
                    .offset(x: offset.width + dragged.width, y: offset.height + dragged.height)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.clear)
            // Without this the canvas draws over the header when panned: a
            // ZStack doesn't bound its children, so content simply carries on
            // upward past the bar that is supposed to be above it.
            .clipped()
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                if case let .active(point) = phase { cursor = point }
            }
            .gesture(
                DragGesture()
                    .onChanged { dragged = $0.translation }
                    .onEnded { _ in
                        offset.width += dragged.width
                        offset.height += dragged.height
                        dragged = .zero
                    }
            )
            .gesture(
                MagnificationGesture()
                    .onChanged { value in zoom(to: pinchStart * value, in: geo.size) }
                    .onEnded { _ in pinchStart = scale }
            )
            .overlay(alignment: .bottomTrailing) { zoomControls(in: geo.size).padding(10) }
            .onAppear {
                centre(in: geo.size)
                // Only while a canvas is on screen: a monitor left running
                // would eat scrolling everywhere else in the app.
                scrollPan.shouldPan = { [weak scrollPanBox] in
                    !(scrollPanBox?.overScrollableNote ?? false)
                }
                scrollPan.start { dx, dy in
                    offset.width += dx
                    offset.height += dy
                }
            }
            .onDisappear { scrollPan.stop() }
        }
    }

    /// Zoom about the pointer rather than the middle of the window.
    ///
    /// Anchoring at the centre means the thing being looked at slides away as
    /// it grows, and the way to inspect a corner becomes zoom, pan back, zoom,
    /// pan back. Keeping the point under the cursor fixed is what makes a
    /// canvas feel like a surface rather than a picture being resized.
    private func zoom(to next: CGFloat, in size: CGSize) {
        let clamped = min(2.5, max(0.2, next))
        guard clamped != scale else { return }
        // Where the cursor is, relative to the centre the scale is applied about.
        let anchor = CGPoint(x: (cursor?.x ?? size.width / 2) - size.width / 2,
                             y: (cursor?.y ?? size.height / 2) - size.height / 2)
        // The content coordinate currently under it, which must not move.
        let contentX = (anchor.x - offset.width) / scale
        let contentY = (anchor.y - offset.height) / scale
        offset = CGSize(width: anchor.x - contentX * clamped,
                        height: anchor.y - contentY * clamped)
        scale = clamped
    }

    /// The dot grid, drawn in view space so the dots stay a constant size while
    /// their spacing tracks the zoom — which is what makes them read as a
    /// surface the content sits on rather than as more content.
    private func dotGrid(in size: CGSize) -> some View {
        Canvas { context, _ in
            let spacing = 24 * scale
            guard spacing > 6 else { return }
            let ox = (offset.width + dragged.width).truncatingRemainder(dividingBy: spacing)
            let oy = (offset.height + dragged.height).truncatingRemainder(dividingBy: spacing)
            var y = oy - spacing
            while y < size.height + spacing {
                var x = ox - spacing
                while x < size.width + spacing {
                    context.fill(
                        Path(ellipseIn: CGRect(x: x, y: y, width: 1.6, height: 1.6)),
                        with: .color(.secondary.opacity(0.28))
                    )
                    x += spacing
                }
                y += spacing
            }
        }
        .allowsHitTesting(false)
    }

    /// Every drawable thing on the canvas, by the id an edge would name it by.
    private struct Node {
        let id: String
        let rect: CGRect
    }

    /// The area every node covers, with a margin so nothing sits on the edge.
    private var contentBounds: CGRect {
        let rects = nodes.map(\.rect)
        guard let first = rects.first else { return .zero }
        let union = rects.dropFirst().reduce(first) { $0.union($1) }
        return union.insetBy(dx: -60, dy: -60)
    }

    private var edgeLayer: some View {
        let bounds = contentBounds
        let index = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0.rect) })
        return Canvas { ctx, _ in
            for edge in board.edges {
                guard let fr = index[edge.from], let to = index[edge.to] else { continue }
                let shift = CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY)

                // Which sides the line uses is a fact about where the two boxes
                // are now, not about where they were when it was drawn. The
                // stored pair is a record of how it started; using it meant a
                // line leaving the far side of a box and looping round, with
                // the arrowhead landing inside the node it was pointing at.
                let fromSide = Self.facingSide(fr, to)
                let toSide = Self.facingSide(to, fr)
                let a = Self.anchor(fr, fromSide).applying(shift)
                let b = Self.anchor(to, toSide).applying(shift)

                // A cubic, with each control point pushed out along the side it
                // leaves — the same 46 the web app uses, so a connection curves
                // away from its box rather than cutting the corner.
                let ext: CGFloat = 46
                let o1 = Self.outward(fromSide), o2 = Self.outward(toSide)
                let c1 = CGPoint(x: a.x + o1.dx * ext, y: a.y + o1.dy * ext)
                let c2 = CGPoint(x: b.x + o2.dx * ext, y: b.y + o2.dy * ext)

                let tint = edge.color.flatMap { Color(hex: $0) } ?? Theme.accentInk.opacity(0.6)
                var line = Path()
                line.move(to: a)
                line.addCurve(to: b, control1: c1, control2: c2)
                ctx.stroke(
                    line,
                    with: .color(tint),
                    style: StrokeStyle(lineWidth: edge.width, lineCap: .round, dash: dashPattern(edge.dash))
                )

                // Aimed along the curve's tangent where it arrives, not along
                // the straight line between the ends — on a curve those differ
                // enough to make an arrowhead sit askew.
                if edge.arrow == "forward" || edge.arrow == "both" {
                    ctx.fill(Self.arrowHead(at: b, along: CGVector(dx: b.x - c2.x, dy: b.y - c2.y)), with: .color(tint))
                }
                if edge.arrow == "back" || edge.arrow == "both" {
                    ctx.fill(Self.arrowHead(at: a, along: CGVector(dx: a.x - c1.x, dy: a.y - c1.y)), with: .color(tint))
                }

                if let label = edge.label, !label.isEmpty {
                    let mid = CGPoint(
                        x: (a.x + b.x) / 2 + (c1.x + c2.x - a.x - b.x) * 0.19,
                        y: (a.y + b.y) / 2 + (c1.y + c2.y - a.y - b.y) * 0.19
                    )
                    ctx.draw(Text(label).font(Theme.chrome(9)), at: mid)
                }
            }
        }
        .frame(width: bounds.width, height: bounds.height)
        .offset(x: bounds.minX, y: bounds.minY)
        .allowsHitTesting(false)
    }

    private func dashPattern(_ dash: String) -> [CGFloat] {
        switch dash {
        case "dashed": return [9, 6]
        case "dotted": return [2, 6]
        default: return []
        }
    }

    /// The side of `a` that faces `b` — measured against each box's own
    /// proportions, so a wide, short node doesn't always answer "east".
    private static func facingSide(_ a: CGRect, _ b: CGRect) -> String {
        let dx = b.midX - a.midX
        let dy = b.midY - a.midY
        if abs(dx) / max(a.width, 1) > abs(dy) / max(a.height, 1) { return dx > 0 ? "e" : "w" }
        return dy > 0 ? "s" : "n"
    }

    private static func outward(_ side: String) -> CGVector {
        switch side {
        case "n": return CGVector(dx: 0, dy: -1)
        case "s": return CGVector(dx: 0, dy: 1)
        case "w": return CGVector(dx: -1, dy: 0)
        default: return CGVector(dx: 1, dy: 0)
        }
    }

    private static func anchor(_ rect: CGRect, _ side: String) -> CGPoint {
        switch side {
        case "n": return CGPoint(x: rect.midX, y: rect.minY)
        case "s": return CGPoint(x: rect.midX, y: rect.maxY)
        case "w": return CGPoint(x: rect.minX, y: rect.midY)
        default: return CGPoint(x: rect.maxX, y: rect.midY)
        }
    }

    private static func arrowHead(at tip: CGPoint, along v: CGVector) -> Path {
        let angle = atan2(v.dy, v.dx)
        let size: CGFloat = 9
        let spread: CGFloat = .pi / 7
        var p = Path()
        p.move(to: tip)
        p.addLine(to: CGPoint(x: tip.x - size * cos(angle - spread), y: tip.y - size * sin(angle - spread)))
        p.addLine(to: CGPoint(x: tip.x - size * cos(angle + spread), y: tip.y - size * sin(angle + spread)))
        p.closeSubpath()
        return p
    }

    /// Only members that were actually placed;
    /// Only members that were actually placed; an unplaced one has no position
    /// to draw it at and would pile up at the origin.
    private var placed: [Daemon.Card] {
        board.members.filter { $0.x != nil && $0.y != nil }
    }

    private var nodes: [Node] {
        placed.map { Node(id: $0.id, rect: CGRect(x: $0.x ?? 0, y: $0.y ?? 0, width: $0.w ?? 220, height: $0.h ?? 90)) }
            + board.notes.map { Node(id: $0.id, rect: CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h)) }
    }

    private var canvasContent: some View {
        ZStack(alignment: .topLeading) {
            // Connections first, so nodes sit above their own lines.
            //
            // Resolved against notes as well as blocks: on a real canvas most
            // connections are between stickies, and matching only blocks drew
            // nothing at all while looking like it had tried.
            // Every edge in one Canvas, sized and placed to match the nodes.
            //
            // A Path carrying absolute coordinates does not stay where it was
            // told: a ZStack takes the path's bounding box and places *that* at
            // its own alignment point, so a line drawn from (500,300) is quietly
            // translated somewhere else. Lines looked roughly right by accident;
            // the arrowheads, which have to land exactly on a box's edge, ended
            // up inside the boxes. A Canvas has one coordinate space and honours
            // it, which is the only way this is reliable.
            edgeLayer

            ForEach(board.notes) { note in
                // Sized as drawn on the web, and scrolling: a sticky holds as
                // much as someone typed into it, and clipping it silently is
                // how a note becomes half a note.
                ScrollView {
                    Text(note.text)
                        .font(Theme.body(10.5))
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(8)
                }
                .frame(width: note.w, height: note.h)
                // Let the note keep the scroll while the pointer is on it. The
                // hit-testing is SwiftUI's, which beats working out where a note
                // landed after a pan and a zoom.
                .onHover { scrollPanBox.overScrollableNote = $0 }
                .background(RoundedRectangle(cornerRadius: 5)
                    .fill(note.color.flatMap { Color(hex: $0) } ?? Theme.postit))
                .overlay(RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(Color.black.opacity(0.10), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.10), radius: 2, x: 1, y: 1)
                .offset(x: note.x, y: note.y)
            }

            ForEach(placed) { card in
                node(card)
            }
        }
    }

    /// One placed block. Split out because the whole canvas as a single
    /// expression was more than the type checker would take.
    private func node(_ card: Daemon.Card) -> some View {
        ScrollView {
            CardRow(card: card, model: model).padding(6)
        }
        // The whole box opens the block, not only the line of text inside it —
        // a card in a scroll view is mostly scroll view, and clicking the space
        // around the title did nothing.
        .contentShape(Rectangle())
        .onTapGesture { if let u = URL(string: card.url) { Opener.open(u) } }
        .frame(width: card.w ?? 220, height: card.h ?? 90)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(.background))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cardRadius)
                .strokeBorder(Theme.accent.opacity(0.30), lineWidth: 0.75)
        )
        .shadow(color: .black.opacity(0.10), radius: 3, x: 1, y: 2)
        .offset(x: card.x ?? 0, y: card.y ?? 0)
    }

    private func zoomControls(in size: CGSize) -> some View {
        HStack(spacing: 4) {
            Button { showDots.toggle() } label: {
                Image(systemName: showDots ? "circle.grid.3x3.fill" : "circle.grid.3x3")
            }
            .help(showDots ? "Hide the grid" : "Show the grid")
            Divider().frame(height: 11)
            Button { zoom(to: scale - 0.15, in: size) } label: { Image(systemName: "minus.magnifyingglass") }
            Button { zoom(to: scale + 0.15, in: size) } label: { Image(systemName: "plus.magnifyingglass") }
            Button {
                scale = 0.75
                pinchStart = 0.75
                centre(in: size)
            } label: { Image(systemName: "arrow.counterclockwise") }
            .help("Fit")
        }
        .buttonStyle(.borderless)
        .font(.system(size: 11))
        .padding(5)
        .background(Capsule().fill(.thinMaterial))
    }

    /// Start with the content in view rather than wherever the origin happens
    /// to be — a canvas laid out around (2000, 1200) otherwise opens on nothing.
    private func centre(in size: CGSize) {
        let boxes = nodes.map(\.rect)
        let xs = boxes.flatMap { [$0.minX, $0.maxX] }
        let ys = boxes.flatMap { [$0.minY, $0.maxY] }
        guard let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() else { return }
        offset = CGSize(
            width: -((minX + maxX) / 2) * scale,
            height: -((minY + maxY) / 2) * scale
        )
    }
}

/// Catches two-finger scrolling so a canvas can be pushed around.
///
/// A local event monitor rather than a view, because the view version could not
/// work: to let clicks and drags reach the nodes underneath it returned nil from
/// `hitTest`, and scroll events are routed by hit-testing too — so the thing
/// existed precisely to receive scrolls and had made itself unable to.
///
/// A monitor sits outside that entirely. It sees the event before the window
/// does, decides whether it is over the canvas, and either acts on it or hands
/// it back untouched.
@MainActor
final class ScrollPan {
    private var monitor: Any?

    /// Whether a scroll right now should pan the canvas.
    ///
    /// Read live rather than captured, because the thing that knows the answer
    /// is a SwiftUI view and those are values — a flag captured when the monitor
    /// started would answer for the moment the canvas appeared, forever.
    var shouldPan: () -> Bool = { true }

    func start(onScroll: @escaping (CGFloat, CGFloat) -> Void) {
        stop()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            // Not everything on a canvas wants to be panned over. A sticky note
            // holds as much as somebody typed and scrolls inside itself, and
            // this monitor swallowed every scroll on the surface — so a note
            // taller than its own frame could be looked at and never read.
            guard self?.shouldPan() ?? true else { return event }
            // Precise deltas come from a trackpad and are already in points; a
            // mouse wheel reports lines, which needs a multiplier or the canvas
            // barely moves.
            let scale: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 12
            onScroll(event.scrollingDeltaX * scale, event.scrollingDeltaY * scale)
            // Swallowed: nothing behind a canvas wants this scroll, and letting
            // it through would scroll a list underneath at the same time.
            return nil
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
    }
}

/// One rollup row and everything beneath it.
///
/// Recursive rather than two hard-coded tiers: a rollup is as deep as it was
/// configured to be, and a renderer that stops at the second level shows part of
/// the answer while looking like all of it.
private struct RollupNode: View {
    let node: Daemon.Group
    let depth: Int
    @ObservedObject var model: BoardModel
    @State private var open = true
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if !node.children.isEmpty {
                    Button { open.toggle() } label: {
                        Image(systemName: open ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9))
                    }
                    .buttonStyle(.borderless).foregroundStyle(.secondary)
                } else {
                    // Keeps titles aligned whether or not a row can open.
                    Color.clear.frame(width: 11, height: 1)
                }

                if node.canComplete {
                    Image(systemName: node.done ? "checkmark.square.fill" : "square")
                        .font(.system(size: 11))
                        .foregroundStyle(node.done ? Theme.accent : Color.secondary)
                }

                Text(node.title)
                    .font(depth == 0 ? Theme.chrome(11.5, weight: .semibold) : Theme.body(11))
                    .strikethrough(node.done)
                    .foregroundStyle(node.done ? .secondary : .primary)
                    .lineLimit(1)

                if !node.children.isEmpty {
                    Text("\(node.children.count)")
                        .font(Theme.chrome(9.5)).foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(Color.secondary.opacity(0.13)))
                }
                if let due = node.due {
                    Text(due).font(Theme.chrome(9.5)).foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 3).padding(.horizontal, 5)
            .background(
                RoundedRectangle(cornerRadius: Theme.controlRadius)
                    .fill(hovering ? Theme.accent.opacity(0.10) : Color.clear)
            )
            .onHover { hovering = $0 }
            .contentShape(Rectangle())
            .onTapGesture { if let u = URL(string: node.url) { Opener.open(u) } }

            if open {
                ForEach(node.children) { child in
                    RollupNode(node: child, depth: depth + 1, model: model)
                        // Indent per level, so depth is visible rather than
                        // inferred from what the titles happen to say.
                        .padding(.leading, 14)
                }
            }
        }
    }
}

/// One connection, drawn the way it was drawn.
///
/// A canvas's edges carry a side to leave from, a side to arrive at, a dash
/// pattern, a width, a colour and which ends wear an arrow. Reduced to a plain
/// line between two centres — which is what this was — a diagram someone
/// arranged becomes a handful of anonymous strokes.
private struct EdgeShape: View {
    let edge: Daemon.Edge
    let from: CGRect
    let to: CGRect

    var body: some View {
        let a = anchor(from, edge.fromSide)
        let b = anchor(to, edge.toSide)
        let tint = edge.color.flatMap { Color(hex: $0) } ?? Theme.accentInk.opacity(0.55)
        // A Group, not a ZStack. A ZStack takes a frame of its own and lays its
        // children out inside it, so paths drawn in absolute canvas coordinates
        // were being re-placed relative to that frame — the line survived
        // because it defined the frame, and the arrowhead, sitting at one end
        // of it, did not. A Group is layout-neutral, so both stay where the
        // coordinates put them.
        Group {
            Path { p in
                p.move(to: a)
                p.addLine(to: b)
            }
            .stroke(tint, style: StrokeStyle(lineWidth: edge.width, lineCap: .round, dash: dashPattern))

            if edge.arrow == "forward" || edge.arrow == "both" { arrowHead(at: b, from: a, tint: tint) }
            if edge.arrow == "back" || edge.arrow == "both" { arrowHead(at: a, from: b, tint: tint) }

            if let label = edge.label, !label.isEmpty {
                Text(label)
                    .font(Theme.chrome(9))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Capsule().fill(.background.opacity(0.85)))
                    .position(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
            }
        }
    }

    private var dashPattern: [CGFloat] {
        switch edge.dash {
        case "dashed": return [6, 4]
        case "dotted": return [1.5, 4]
        default: return []
        }
    }

    /// The middle of the named side, so a line leaves a box where it was drawn
    /// to leave it rather than from its centre.
    private func anchor(_ rect: CGRect, _ side: String) -> CGPoint {
        switch side {
        case "n": return CGPoint(x: rect.midX, y: rect.minY)
        case "s": return CGPoint(x: rect.midX, y: rect.maxY)
        case "w": return CGPoint(x: rect.minX, y: rect.midY)
        case "e": return CGPoint(x: rect.maxX, y: rect.midY)
        default: return CGPoint(x: rect.midX, y: rect.midY)
        }
    }

    private func arrowHead(at tip: CGPoint, from origin: CGPoint, tint: Color) -> some View {
        let angle = atan2(tip.y - origin.y, tip.x - origin.x)
        let size: CGFloat = 7
        let spread: CGFloat = .pi / 7
        return Path { p in
            p.move(to: tip)
            p.addLine(to: CGPoint(x: tip.x - size * cos(angle - spread), y: tip.y - size * sin(angle - spread)))
            p.addLine(to: CGPoint(x: tip.x - size * cos(angle + spread), y: tip.y - size * sin(angle + spread)))
            p.closeSubpath()
        }
        .fill(tint)
    }
}

/// Holds the scroll monitor for as long as the canvas is on screen.
///
/// A `@StateObject` because the monitor has to outlive a redraw: created in
/// `@State` it would be torn down and re-made on every view update, and torn
/// down at the wrong moment leaves the app with no way to pan.
@MainActor
final class ScrollPanBox: ObservableObject {
    let pan = ScrollPan()

    /// Set by whichever sticky note the pointer is over, cleared when it leaves.
    /// Deliberately not `@Published`: it is read by an event monitor rather than
    /// drawn, and republishing the whole canvas on every hover would be a lot of
    /// redrawing to decide where a scroll should go.
    var overScrollableNote = false
}
