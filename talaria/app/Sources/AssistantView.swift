import SwiftUI

/// A prompt, anywhere.
///
/// The one surface here that genuinely needs the network: the model runs on the
/// Hermes server against the user's own Ollama. Everything else in this app
/// answers from the mirror, so when this one can't work it says exactly that
/// rather than spinning — an inconsistency worth being loud about.
@MainActor
final class AssistantModel: ObservableObject {
    struct Turn: Identifiable {
        let id = UUID()
        let mine: Bool
        let text: String
    }

    @Published var turns: [Turn] = []
    @Published var draft = ""
    @Published var busy = false
    @Published var error: String?
    /// Destructive calls the assistant wants permission for. Nothing has run.
    @Published var pending: [Daemon.PendingCall] = []

    func send() {
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !busy else { return }
        draft = ""
        error = nil
        pending = []
        turns.append(Turn(mine: true, text: message))
        busy = true
        Task.detached(priority: .userInitiated) { [self] in
            do {
                let turn = try Daemon.assistant(message)
                await MainActor.run {
                    if !turn.reply.isEmpty { self.turns.append(Turn(mine: false, text: turn.reply)) }
                    self.pending = turn.pending
                    self.busy = false
                }
            } catch {
                await MainActor.run {
                    self.error = "\(error)"
                    self.busy = false
                }
            }
        }
    }

    func approve() {
        let calls = pending
        guard !calls.isEmpty else { return }
        busy = true
        pending = []
        Task.detached(priority: .userInitiated) { [self] in
            do {
                try Daemon.assistantConfirm(calls)
                await MainActor.run {
                    self.turns.append(Turn(mine: false, text: "Done."))
                    self.busy = false
                }
            } catch {
                await MainActor.run { self.error = "\(error)"; self.busy = false }
            }
        }
    }

    func decline() {
        pending = []
        turns.append(Turn(mine: false, text: "_Not done._"))
    }
}

struct AssistantView: View {
    @ObservedObject var model: AssistantModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if model.turns.isEmpty && model.error == nil {
                            Text("Ask Hermes something. It can search, and it can act — anything destructive comes back for your approval first.")
                                .font(.callout).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        ForEach(model.turns) { turn in bubble(turn).id(turn.id) }
                        if model.busy {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("thinking…").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if let error = model.error {
                            Text(error)
                                .font(.callout).foregroundStyle(.orange)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: model.turns.count) {
                    if let last = model.turns.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }

            if !model.pending.isEmpty { confirmation }

            Divider()
            HStack(spacing: 8) {
                TextField("Ask Hermes…", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .focused($focused)
                    .onSubmit { model.send() }
                Button { model.send() } label: { Image(systemName: "arrow.up.circle.fill") }
                    .buttonStyle(.borderless)
                    .disabled(model.busy || model.draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(10)
        }
        .frame(width: 520, height: 420)
        .onAppear { focused = true }
    }

    /// Nothing has run yet. This is the moment to say no.
    private var confirmation: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Hermes wants to do \(model.pending.count == 1 ? "this" : "these"):")
                .font(.caption.weight(.semibold))
            ForEach(Array(model.pending.enumerated()), id: \.offset) { _, call in
                Text("• \(call.tool)").font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button("Do it") { model.approve() }.keyboardShortcut(.defaultAction)
                Button("No") { model.decline() }.keyboardShortcut(.cancelAction)
            }
            .padding(.top, 2)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12))
    }

    private func bubble(_ turn: AssistantModel.Turn) -> some View {
        HStack {
            if turn.mine { Spacer(minLength: 40) }
            Text(turn.text)
                .font(.callout)
                .textSelection(.enabled)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(turn.mine ? AnyShapeStyle(Color.accentColor.opacity(0.18)) : AnyShapeStyle(.quaternary.opacity(0.4)))
                )
            if !turn.mine { Spacer(minLength: 40) }
        }
    }
}
