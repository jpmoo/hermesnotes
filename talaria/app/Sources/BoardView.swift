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
                grid(board)
                // Always drawn, even with nothing in it. Hiding it when empty
                // took the drop target away at exactly the moment it was needed
                // — there was nowhere to put the first card you wanted out of
                // the grid.
                Divider()
                drawer(board.drawer).frame(height: board.drawer.isEmpty ? 52 : 88)
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
                ForEach(model.boards, id: \.id) { b in Text(b.title).tag(b.id) }
            }
            .labelsHidden()
            .frame(maxWidth: 260)
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
                Text(region.title).font(.caption.weight(.semibold))
                Spacer()
                Text("\(cards.count)").font(.caption2).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8).padding(.top, 6)

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
            RoundedRectangle(cornerRadius: 8)
                // The region's own colour, at a weight that a card can still be
                // read on top of. Hermes stores it with alpha already.
                .fill(tint ?? Color.secondary.opacity(0.12))
        )
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary, lineWidth: 0.5))
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
                    .foregroundStyle(card.done ? Color.accentColor : .secondary)
            }
            .buttonStyle(.borderless)
            .help(card.done ? "Already done" : "Mark complete")
            .disabled(card.done)

            VStack(alignment: .leading, spacing: 1) {
                Text(card.title)
                    .font(.caption)
                    .strikethrough(card.done)
                    .foregroundStyle(card.done ? .secondary : .primary)
                    .lineLimit(2)
                if let due = card.due {
                    Text(due).font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3).padding(.horizontal, 5)
        .background(RoundedRectangle(cornerRadius: 5).fill(hovering ? AnyShapeStyle(.selection) : AnyShapeStyle(.background.opacity(0.6))))
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
