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
        /// The tools this turn ran, shown above the reply as the web app does.
        var steps: [Daemon.Step] = []
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
                    if !turn.reply.isEmpty || !turn.steps.isEmpty {
                        self.turns.append(Turn(mine: false, text: turn.reply, steps: turn.steps))
                    }
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
                let steps = try Daemon.assistantConfirm(calls)
                await MainActor.run {
                    self.turns.append(Turn(mine: false, text: "Done.", steps: steps))
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
    /**
     Its own window, or somebody else's.

     The same distinction `ComposeView` and `GlanceView` already draw, and for
     the same reason: a panel that owns a window draws its own title and decides
     its own size, and the identical panel inside a pane must do neither — the
     pane has a title and the layout has already decided how big this is.
     */
    var standalone = true
    /**
     Whether appearing means the keyboard.

     True for a window somebody summoned and for a drawer somebody pulled open —
     both are "I want to type now". False in a quadrant of the desk, which
     appears because the desk appeared; taking the caret there would mean the
     scratchpad lost it every time the overlay opened, to a pane nobody looked
     at.
     */
    var autofocus = true
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if standalone {
                header
                Divider()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if model.turns.isEmpty && model.error == nil { placeholder }
                        ForEach(model.turns) { turn in bubble(turn).id(turn.id) }
                        if model.busy { thinking }
                        if let error = model.error { errorRow(error) }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: model.turns.count) {
                    if let last = model.turns.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
            }
            if !model.pending.isEmpty { confirmation }
            Divider()
            composer
        }
        .frame(width: standalone ? 540 : nil, height: standalone ? 460 : nil)
        .frame(maxWidth: standalone ? nil : .infinity, maxHeight: standalone ? nil : .infinity)
        .onAppear { if autofocus { focused = true } }
    }

    private var header: some View {
        HStack(spacing: 7) {
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: 12)).foregroundStyle(Theme.accent)
            Text("Ask Hermes Notes").font(Theme.chrome(12, weight: .semibold))
            Spacer()
            if !model.turns.isEmpty {
                Button {
                    model.turns.removeAll(); model.pending = []; model.error = nil
                } label: {
                    Image(systemName: "trash").font(.system(size: 11))
                }
                .buttonStyle(.borderless).foregroundStyle(.secondary)
                .help("Clear this conversation")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
    }

    private var placeholder: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Ask about anything in Hermes Notes.")
                .font(Theme.body(12)).foregroundStyle(.secondary)
            ForEach(["What's due this week?",
                     "Mark the roof task done",
                     "Summarize my notes on dual enrollment"], id: \.self) { example in
                HStack(spacing: 6) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.system(size: 9)).foregroundStyle(Theme.accent.opacity(0.7))
                    Text(example).font(Theme.body(11.5)).foregroundStyle(.secondary)
                }
            }
            Text("Anything destructive comes back for your approval first.")
                .font(Theme.body(11)).foregroundStyle(.tertiary).padding(.top, 3)
        }
    }

    private var thinking: some View {
        HStack(spacing: 7) {
            ProgressView().controlSize(.small)
            Text("thinking…").font(Theme.body(11)).foregroundStyle(.secondary)
        }
    }

    private func errorRow(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11)).foregroundStyle(Theme.danger)
            Text(text).font(Theme.body(11.5)).foregroundStyle(Theme.danger)
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.controlRadius)
            .fill(Theme.danger.opacity(0.10)))
    }

    /// One tool call, the way the web app shows it: icon, name, first line.
    private func stepRow(_ step: Daemon.Step) -> some View {
        let failed = step.ok == false
        return HStack(spacing: 6) {
            Image(systemName: Theme.symbol(forTool: step.tool))
                .font(.system(size: 10))
                .foregroundStyle(failed ? Theme.danger : Theme.accent)
            Text(step.tool).font(Theme.chrome(10.5, weight: .medium))
            Text(firstLine(step.result ?? ""))
                .font(Theme.body(10.5)).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 3.5)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(failed ? Theme.danger.opacity(0.10) : Color.secondary.opacity(0.10))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7)
                .strokeBorder(failed ? Theme.danger.opacity(0.3) : Color.secondary.opacity(0.18), lineWidth: 0.5)
        )
        .help(step.result ?? "")
    }

    private func firstLine(_ s: String) -> String {
        let line = s.split(separator: "\n").first.map(String.init) ?? ""
        return line.count > 90 ? String(line.prefix(90)) + "…" : line
    }

    private func bubble(_ turn: AssistantModel.Turn) -> some View {
        VStack(alignment: turn.mine ? .trailing : .leading, spacing: 5) {
            if !turn.steps.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(turn.steps.enumerated()), id: \.offset) { _, s in stepRow(s) }
                }
                .frame(maxWidth: 400, alignment: .leading)
            }
            if !turn.text.isEmpty {
                MarkdownText(text: turn.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 11).padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.cardRadius)
                            .fill(turn.mine
                                  ? AnyShapeStyle(Theme.accent.opacity(0.16))
                                  : AnyShapeStyle(Color.secondary.opacity(0.10)))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.cardRadius)
                            .strokeBorder(turn.mine ? Theme.accent.opacity(0.28) : Color.secondary.opacity(0.16),
                                          lineWidth: 0.5)
                    )
                    .frame(maxWidth: 420, alignment: turn.mine ? .trailing : .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: turn.mine ? .trailing : .leading)
    }

    /// Nothing has run yet. This is the moment to say no.
    private var confirmation: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised.fill")
                    .font(.system(size: 11)).foregroundStyle(Theme.danger)
                Text("Hermes wants to do \(model.pending.count == 1 ? "this" : "these"):")
                    .font(Theme.chrome(11, weight: .semibold))
            }
            ForEach(Array(model.pending.enumerated()), id: \.offset) { _, call in
                HStack(spacing: 6) {
                    Image(systemName: Theme.symbol(forTool: call.tool))
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.isWeighty(call.tool) ? Theme.danger : Theme.accentInk)
                    Text(call.tool).font(Theme.chrome(11))
                }
            }
            HStack(spacing: 8) {
                Button("Do it") { model.approve() }
                    .keyboardShortcut(.defaultAction)
                Button("No") { model.decline() }
                    .keyboardShortcut(.cancelAction)
            }
            .font(Theme.chrome(11))
            .padding(.top, 1)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.postit.opacity(0.55))
        .overlay(Rectangle().frame(height: 0.5).foregroundStyle(.quaternary), alignment: .top)
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Ask Hermes Notes…", text: $model.draft, axis: .vertical)
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

// MARK: - The drawer

/**
 The canvas's own chat, pulled up from the bottom of it.

 A drawer rather than a fifth quadrant or a second window. The canvas is the one
 surface here that fills the page — there is no spare quarter to put a panel in —
 and asking somebody to leave the canvas to ask a question about what is on it
 is asking them to stop doing the thing they wanted help with.

 Closed it is a tab and nothing else, which is the whole argument for the shape:
 a canvas with a chat panel permanently across the bottom is a canvas that is a
 third smaller for the sake of something used occasionally.

 Kept to the leading edge on purpose. The surface strip sits centered at the very
 bottom of the desk and is drawn over everything; a tab in the middle would be
 underneath it, and a tab that is underneath something is a tab nobody finds.
 */
struct ChatDrawer: View {
    @ObservedObject var model: CanvasChatModel
    @Binding var open: Bool

    /// Tall enough for a question, an answer and the tools it ran, which is the
    /// shortest exchange worth having. Not resizable yet — one size that works
    /// beats a grip nobody has asked for.
    private static let height: CGFloat = 300
    private static let width: CGFloat = 520

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            tab
            if open {
                CanvasChatView(model: model)
                    .frame(width: Self.width, height: Self.height)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.cardRadius)
                            .fill(.background.opacity(0.97))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.cardRadius)
                            .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.18), radius: 14, y: -2)
                    // Up from under the edge it is attached to, so it reads as
                    // one thing coming out of the bottom of the page rather
                    // than a panel that faded in over it.
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 12)
        .padding(.bottom, 8)
    }

    private var tab: some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) { open.toggle() }
        } label: {
            HStack(spacing: 6) {
                // A pencil, not the wings. What draws is not what files, and
                // the Hermes assistant can be open over the top of this one.
                Image(systemName: "pencil.and.scribble")
                    .font(.system(size: 11))
                Text("Draw").font(Theme.chrome(11, weight: .medium))
                Image(systemName: open ? "chevron.down" : "chevron.up")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
            .foregroundStyle(open ? Theme.accent : Color.secondary)
            .background(
                Capsule().fill(.background.opacity(0.88))
                    .overlay(Capsule().strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
            )
            .shadow(color: .black.opacity(0.12), radius: 6, y: 1)
        }
        .buttonStyle(.plain)
        .help(open ? "Close" : "Ask for something to be drawn on this canvas")
        // Above the drawer when it is open, so the two read as one piece: a tab
        // on the lid rather than a button that happens to sit near a panel.
        .padding(.bottom, open ? 6 : 0)
    }
}
