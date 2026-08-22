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

    func choose(_ id: String) {
        selected = id
        UserDefaults.standard.set(id, forKey: lastBoardKey)
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

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let board = model.board {
                if board.kind == "calendar" {
                    AgendaView(model: model.agenda)
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
            Button { model.load() } label: { Image(systemName: "arrow.clockwise") }
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

    /// Everything that isn't a grid or a canvas: a list, in its own order.
    ///
    /// Deliberately one renderer rather than five near-misses. A table, a
    /// masonry and a rollup differ in the web app in ways that matter there and
    /// would be a poor imitation here; what they have in common is a sequence of
    /// blocks, which is the useful part at this size.
    private func sequence(_ cards: [Daemon.Card]) -> some View {
        ScrollView {
            VStack(spacing: 4) {
                ForEach(cards) { card in CardRow(card: card, model: model) }
                if cards.isEmpty {
                    Text("Nothing in this collection")
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
                Capsule().fill(tint ?? Theme.accent.opacity(0.5)).frame(width: 3, height: 11)
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
                    ForEach(cards) { card in CardRow(card: card, model: model) }
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
                .fill((tint ?? Color.secondary).opacity(0.07))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cardRadius)
                .strokeBorder((tint ?? Color.secondary).opacity(0.25), lineWidth: 0.75)
        )
        .onDrop(of: [.text], isTargeted: nil) { providers in
            acceptDrop(providers, into: region.index, model: model)
        }
    }
}

private struct CardRow: View {
    let card: Daemon.Card
    @ObservedObject var model: BoardModel
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Button { model.complete(card) } label: {
                Image(systemName: card.done ? "checkmark.square.fill" : "square")
                    .font(.system(size: 12))
                    .foregroundStyle(card.done ? Theme.accent : .secondary)
            }
            .buttonStyle(.borderless)
            .help(card.done ? "Already done" : "Mark complete")
            .disabled(card.done)

            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(Theme.body(11.5))
                    .strikethrough(card.done)
                    .foregroundStyle(card.done ? .secondary : .primary)
                    .lineLimit(2)
                HStack(spacing: 5) {
                    if let due = card.due {
                        Label(due, systemImage: "calendar")
                            .font(Theme.chrome(9.5)).foregroundStyle(.tertiary).labelStyle(.titleAndIcon)
                    }
                    ForEach(card.tags.prefix(2), id: \.self) { tag in
                        Text("#\(tag)")
                            .font(Theme.chrome(9.5)).foregroundStyle(Theme.accent)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5).padding(.horizontal, 7)
        .background(
            RoundedRectangle(cornerRadius: Theme.controlRadius)
                .fill(hovering ? AnyShapeStyle(Theme.accent.opacity(0.10)) : AnyShapeStyle(.background.opacity(0.75)))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.controlRadius)
                .strokeBorder(hovering ? Theme.accent.opacity(0.35) : Color.secondary.opacity(0.14), lineWidth: 0.5)
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
        .onTapGesture { if let u = URL(string: card.url) { NSWorkspace.shared.open(u) } }
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
    @State private var offset: CGSize = .zero
    @State private var dragged: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Color.clear
                canvasContent
                    .scaleEffect(scale, anchor: .center)
                    .offset(x: offset.width + dragged.width, y: offset.height + dragged.height)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture()
                    .onChanged { dragged = $0.translation }
                    .onEnded { _ in offset.width += dragged.width; offset.height += dragged.height; dragged = .zero }
            )
            .gesture(MagnificationGesture().onChanged { scale = min(2, max(0.25, $0)) })
            .overlay(alignment: .bottomTrailing) { zoomControls.padding(10) }
            .onAppear { centre(in: geo.size) }
        }
    }

    /// Every drawable thing on the canvas, by the id an edge would name it by.
    private struct Node {
        let id: String
        let rect: CGRect
    }

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
            let index = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0.rect) })
            ForEach(Array(board.edges.enumerated()), id: \.offset) { _, edge in
                if let a = index[edge.from], let b = index[edge.to] {
                    Path { p in
                        p.move(to: CGPoint(x: a.midX, y: a.midY))
                        p.addLine(to: CGPoint(x: b.midX, y: b.midY))
                    }
                    .stroke(
                        Theme.accentInk.opacity(0.45),
                        style: StrokeStyle(lineWidth: 1.4, dash: edge.dashed ? [4, 3] : [])
                    )
                }
            }

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
        .frame(width: card.w ?? 220, height: card.h ?? 90)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(.background))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cardRadius)
                .strokeBorder(Theme.accent.opacity(0.30), lineWidth: 0.75)
        )
        .shadow(color: .black.opacity(0.10), radius: 3, x: 1, y: 2)
        .offset(x: card.x ?? 0, y: card.y ?? 0)
    }

    private var zoomControls: some View {
        HStack(spacing: 4) {
            Button { scale = max(0.25, scale - 0.15) } label: { Image(systemName: "minus.magnifyingglass") }
            Button { scale = min(2, scale + 0.15) } label: { Image(systemName: "plus.magnifyingglass") }
            Button { scale = 0.75; offset = .zero } label: { Image(systemName: "arrow.counterclockwise") }
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
