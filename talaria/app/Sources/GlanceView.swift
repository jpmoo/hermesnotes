import SwiftUI

/**
 What the library knows about what you are looking at.

 A different kind of window from the rest of Talaria on purpose. The board and
 the agenda are places you go; this is a thing that appears beside what you are
 already doing and gets out of the way — so it is translucent, chromeless,
 non-activating, and it never takes focus from the document you were typing in.
 A panel that stole the cursor would be answering a question by interrupting the
 work that raised it.

 Muted rather than dim: the type stays legible, the material carries the colour
 of whatever is behind it, and nothing here competes with the application it is
 floating over.
 */

@MainActor
final class GlanceModel: ObservableObject {
    @Published var hits: [Daemon.GlanceHit] = []
    @Published var question: String?
    /// Where the question came from — the document, its title, or typed here.
    @Published var source: String?
    @Published var error: String?
    @Published var busy = false
    /// What the person typed, when they want to ask something other than the window.
    @Published var query = ""

    private var watch: Timer?

    /// Ask about whatever is in front, unless something has been typed.
    func refresh() {
        busy = true
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        Task.detached(priority: .userInitiated) { [weak self] in
            let answer = try? Daemon.glance(query: typed.isEmpty ? nil : typed)
            await MainActor.run {
                guard let self else { return }
                self.busy = false
                guard let answer else {
                    self.error = "the daemon isn't answering"
                    return
                }
                self.hits = answer.data
                self.question = answer.question
                self.source = answer.source
                self.error = answer.error
            }
        }
    }

    /**
     Keep asking while the panel is open.

     The point of leaving it open is that it follows you: move to another
     document and it should be about that one. Polled rather than pushed because
     nothing on this machine emits a "the focused document changed" event — the
     same reason the context record polls — and four seconds is under the time it
     takes to look away and back.
     */
    func startFollowing() {
        stopFollowing()
        refresh()
        let t = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.query.isEmpty else { return }
                self.refresh()
            }
        }
        watch = t
    }

    func stopFollowing() {
        watch?.invalidate()
        watch = nil
    }

    /// Tick something off without leaving the panel.
    func complete(_ hit: Daemon.GlanceHit) {
        guard let completion = hit.block.completion, !completion.done else { return }
        Task.detached(priority: .userInitiated) { [weak self] in
            _ = try? Daemon.complete(id: hit.block.id)
            await MainActor.run { self?.refresh() }
        }
    }
}

struct GlanceView: View {
    @ObservedObject var model: GlanceModel
    @FocusState private var searching: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.35)
            if let error = model.error {
                message(error)
            } else if model.hits.isEmpty {
                message(model.question == nil
                        ? "Nothing in front worth asking about."
                        : "Nothing close to this yet.")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(model.hits) { hit in row(hit) }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .frame(width: 380, height: 420)
        .background(VisualEffect())
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.5)
        )
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "sparkle.magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                // The question, in small type. Worth showing because a result
                // list is unreadable without knowing what it answered — and
                // because seeing your own document text quoted back is the
                // clearest possible statement of what was read.
                Text(model.question ?? "…")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                if model.busy {
                    ProgressView().controlSize(.mini).scaleEffect(0.6)
                } else if let source = model.source {
                    Text(source)
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.tertiary)
                }
            }
            TextField("Search, or leave empty to follow the window", text: $model.query)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($searching)
                .onSubmit { model.refresh() }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }

    private func row(_ hit: Daemon.GlanceHit) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            // Only a thing that can be finished gets a box. A note with a
            // checkbox beside it is a lie about what a note is.
            if let completion = hit.block.completion {
                Button {
                    model.complete(hit)
                } label: {
                    Image(systemName: completion.done ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 12))
                        .foregroundStyle(completion.done ? Color.accentColor : Color.secondary)
                }
                .buttonStyle(.plain)
            } else {
                Image(systemName: Theme.symbol(forTool: hit.block.typeName))
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .frame(width: 14)
            }

            Text(hit.block.title)
                .font(.system(size: 12))
                .foregroundStyle(hit.block.completion?.done == true ? .secondary : .primary)
                .strikethrough(hit.block.completion?.done == true, color: .secondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 4)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .onTapGesture { if let u = URL(string: hit.block.url) { Opener.open(u) } }
    }

    private func message(_ text: String) -> some View {
        VStack {
            Spacer()
            Text(text)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

/// The material behind it. `.hudWindow` is the one that reads as a floating
/// widget rather than as a document window that happens to be small.
private struct VisualEffect: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}
