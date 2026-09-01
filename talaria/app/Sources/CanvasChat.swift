import SwiftUI

/**
 The canvas's own chat, and only the canvas's.

 A second chat in one app needs a reason and a difference somebody can see. The
 reason: this one runs on the user's own inference server against tools that do
 nothing but draw, so a canvas can be arranged with no network beyond this
 machine. The difference has to be visible, because both can be open at once —
 this drawer, and the Hermes assistant summoned over the top of it — and two
 chat boxes that look alike are two chat boxes somebody types the wrong thing
 into.

 So it says what it does not do, in the placeholder and in the empty state, and
 it wears a pencil rather than the wings. What draws is not what files.
 */
@MainActor
final class CanvasChatModel: ObservableObject {
    struct Turn: Identifiable {
        let id = UUID()
        let mine: Bool
        let text: String
        var steps: [Daemon.CanvasStep] = []
    }

    @Published var turns: [Turn] = []
    @Published var draft = ""
    @Published var busy = false
    @Published var error: String?
    /// Whether a chat model has been chosen. Read from the config rather than
    /// asked of the daemon: it is one local file, it is what Settings writes,
    /// and a socket call to learn whether a button should exist is a socket
    /// call made on every redraw.
    ///
    /// False until asked. A property initializer cannot read it — the read is
    /// isolated to the main actor and the initializer is not — and defaulting
    /// to false is the right way round anyway: a tool that appears once the
    /// answer is known is better than one that appears and then vanishes.
    @Published var available = false

    /**
     Told after every turn, so the canvas can read the file again.

     The tools run in the daemon and write `canvas.json` directly; this app
     holds the same document in memory. Somebody has to say "that changed", and
     the chat is the only thing that knows when.
     */
    var onDrew: (() -> Void)?

    init() { recheck() }

    /// Asked again when the panel appears, so choosing a model in Settings and
    /// coming back does not need a relaunch.
    func recheck() { available = !ConfigStore.load().inferenceModel.isEmpty }

    func send() {
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !busy else { return }
        draft = ""
        error = nil
        turns.append(Turn(mine: true, text: message))
        busy = true
        // What has been said so far, so "make them orange too" means something.
        // Trimmed to the last few exchanges: a canvas conversation is short and
        // a local model's context is not free.
        let history = turns.suffix(8).map { (mine: $0.mine, text: $0.text) }
        Task.detached(priority: .userInitiated) { [history] in
            do {
                let turn = try Daemon.canvasChat(message, history: history.dropLast())
                await MainActor.run {
                    self.turns.append(Turn(mine: false, text: turn.reply, steps: turn.steps))
                    self.busy = false
                    // Even when the turn drew nothing: a turn that only read is
                    // cheap to reload after, and working out which ones wrote
                    // means the canvas trusting the model's account of itself.
                    self.onDrew?()
                }
            } catch {
                await MainActor.run {
                    self.error = "\(error)"
                    self.busy = false
                }
            }
        }
    }
}

extension Daemon {
    struct CanvasStep: Decodable, Hashable {
        let tool: String
        let result: String
        let ok: Bool
    }
    struct CanvasTurn: Decodable {
        let reply: String
        let steps: [CanvasStep]
        let stopped: Bool?
    }

    static func canvasChat(_ message: String, history: [(mine: Bool, text: String)]) throws -> CanvasTurn {
        let past = history.map { ["role": $0.mine ? "user" : "assistant", "content": $0.text] }
        return try JSONDecoder().decode(
            Envelope<CanvasTurn>.self,
            from: post("/canvas/chat", ["message": message, "history": past])
        ).data
    }
}

/**
 The drawer's contents.

 Deliberately not `AssistantView` with a flag. That panel is the Hermes
 assistant — its placeholder offers to summarise notes and mark tasks done, and
 every one of those is a thing this chat cannot do. A shared view with a
 parameter would have kept them looking identical, which is the one property
 two chats in one window must not have.
 */
struct CanvasChatView: View {
    @ObservedObject var model: CanvasChatModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if model.turns.isEmpty, model.error == nil { placeholder }
                        ForEach(model.turns) { turn in bubble(turn).id(turn.id) }
                        if model.busy {
                            HStack(spacing: 7) {
                                ProgressView().controlSize(.small)
                                Text("drawing…").font(Theme.body(11)).foregroundStyle(.secondary)
                            }
                        }
                        if let error = model.error { trouble(error) }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: model.turns.count) {
                    if let last = model.turns.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            Divider()
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { focused = true }
    }

    /// Says what it is for, and — as plainly — what it is not.
    private var placeholder: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("This draws on the canvas. Nothing else.")
                .font(Theme.chrome(11, weight: .semibold))
            ForEach(["Add a node for each step of the release",
                     "Make the orange ones circles",
                     "Group these three and call it Blockers",
                     "Find my 1Offs tasks and put them on here"], id: \.self) { example in
                HStack(spacing: 6) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 9)).foregroundStyle(Theme.accent.opacity(0.7))
                    Text(example).font(Theme.body(11.5)).foregroundStyle(.secondary)
                }
            }
            Text("It can look things up in Hermes Notes to put them here, and it cannot change anything there — no new tasks, no completing, no renaming. The Hermes assistant does that.")
                .font(Theme.body(11))
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        }
    }

    private func trouble(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11)).foregroundStyle(Theme.danger)
            Text(text).font(Theme.body(11.5)).foregroundStyle(Theme.danger)
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Theme.danger.opacity(0.10)))
    }

    /// One tool call, named and answered. The canvas changes under the drawer
    /// while these arrive, so the line is a record rather than the only sign.
    private func stepRow(_ step: Daemon.CanvasStep) -> some View {
        HStack(spacing: 6) {
            Image(systemName: step.ok ? "pencil.line" : "exclamationmark.triangle")
                .font(.system(size: 10))
                .foregroundStyle(step.ok ? Theme.accent : Theme.danger)
            Text(step.result).font(Theme.body(10.5)).foregroundStyle(.secondary).lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 3.5)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.secondary.opacity(0.10)))
    }

    private func bubble(_ turn: CanvasChatModel.Turn) -> some View {
        VStack(alignment: turn.mine ? .trailing : .leading, spacing: 5) {
            if !turn.steps.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(turn.steps, id: \.self) { stepRow($0) }
                }
                .frame(maxWidth: 380, alignment: .leading)
            }
            if !turn.text.isEmpty {
                Text(turn.text)
                    .font(Theme.body(12))
                    .textSelection(.enabled)
                    .padding(.horizontal, 11).padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.cardRadius)
                            .fill(turn.mine ? AnyShapeStyle(Theme.accent.opacity(0.16))
                                            : AnyShapeStyle(Color.secondary.opacity(0.10)))
                    )
                    .frame(maxWidth: 400, alignment: turn.mine ? .trailing : .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: turn.mine ? .trailing : .leading)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Draw something on this canvas…", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(Theme.body(12))
                .lineLimit(1...4)
                .focused($focused)
                .onSubmit { model.send() }
            Button { model.send() } label: {
                Image(systemName: "arrow.up.circle.fill").font(.system(size: 16))
            }
            .buttonStyle(.borderless)
            .foregroundStyle(model.draft.trimmingCharacters(in: .whitespaces).isEmpty
                             ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Theme.accent))
            .disabled(model.busy || model.draft.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }
}
