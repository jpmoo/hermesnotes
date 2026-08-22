import SwiftUI

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

    func choose(_ id: String) {
        selected = id
        UserDefaults.standard.set(id, forKey: lastBoardKey)
        load()
    }

    /// Optimistic: the daemon writes the move into the mirror before answering,
    /// so reloading shows the card where it was dropped whether or not Hermes
    /// was reachable.
    func move(_ card: Daemon.Card, to region: Int) {
        guard let boardId = board?.id else { return }
        Task.detached(priority: .userInitiated) { [self] in
            do {
                try Daemon.write(["kind": "move", "collectionId": boardId, "blockId": card.id, "region": region])
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

struct BoardView: View {
    @ObservedObject var model: BoardModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let board = model.board {
                grid(board)
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
        .frame(width: 560, height: 460)
    }

    private var header: some View {
        HStack(spacing: 8) {
            if model.boards.count > 1 {
                Picker("", selection: Binding(
                    get: { model.selected ?? "" },
                    set: { model.choose($0) }
                )) {
                    ForEach(model.boards, id: \.id) { b in Text(b.title).tag(b.id) }
                }
                .labelsHidden()
                .frame(maxWidth: 240)
            } else {
                Text(model.board?.title ?? "Talaria").font(.headline)
            }
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
        ScrollView {
            let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: board.cols)
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(board.regions, id: \.index) { region in
                    cell(region, cards: board.cells[String(region.index)] ?? [])
                }
            }
            .padding(8)
            let unplaced = board.cells["unplaced"] ?? []
            if !unplaced.isEmpty {
                // Added to the collection but never placed. A real state, so it
                // gets shown rather than quietly filed into the first cell.
                cell(Daemon.Region(index: -1, title: "Unplaced", color: nil), cards: unplaced)
                    .padding(.horizontal, 8).padding(.bottom, 8)
            }
        }
    }

    private func cell(_ region: Daemon.Region, cards: [Daemon.Card]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if let hex = region.color, let c = Color(hex: hex) {
                    Circle().fill(c).frame(width: 7, height: 7)
                }
                Text(region.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Text("\(cards.count)").font(.caption2).foregroundStyle(.tertiary)
            }
            ForEach(cards) { card in CardRow(card: card, model: model) }
            if cards.isEmpty {
                Text("—").font(.caption2).foregroundStyle(.quaternary).padding(.vertical, 2)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, minHeight: 110, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary.opacity(0.35)))
        // Only a placed region can be dropped into; "Unplaced" is where things
        // arrive from, not somewhere to put them.
        .dropDestination(for: String.self) { ids, _ in
            guard region.index >= 0, let id = ids.first,
                  let card = model.board?.cells.values.flatMap({ $0 }).first(where: { $0.id == id })
            else { return false }
            model.move(card, to: region.index)
            return true
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
        .onTapGesture { if let u = URL(string: card.url) { NSWorkspace.shared.open(u) } }
        .draggable(card.id) {
            Text(card.title).font(.caption).padding(4)
                .background(RoundedRectangle(cornerRadius: 4).fill(.thinMaterial))
        }
    }
}

extension Color {
    /// Region colours come from Hermes as hex, or as something we don't know.
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")).lowercased()
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = Int(s, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((v >> 16) & 0xff) / 255,
            green: Double((v >> 8) & 0xff) / 255,
            blue: Double(v & 0xff) / 255
        )
    }
}
