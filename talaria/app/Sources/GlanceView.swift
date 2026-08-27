import ApplicationServices
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

/**
 What is being typed, read by the app rather than by a helper.

 There is a `talaria-ax` binary in this bundle that does the same job for the
 command line, and for a while it did this one too. It could not: macOS keys an
 accessibility grant to a program's code signature, the helper signs as
 `talaria-ax` while the app signs as `dev.talaria.Talaria`, and so a grant on
 Talaria.app never covered it. Both are ad-hoc signed as well, which means the
 hash changes on every rebuild and any grant that *did* apply would go stale the
 next time the thing was built.

 Reading it here sidesteps all of that. The app is what somebody added to the
 Accessibility list, so the app is what asks.

 Never prompts. Denied, it returns nothing and Glance falls back to the window
 title, which is worse but real.
 */
enum Focused {
    static var maxChars = 4000

    private static func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var out: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &out) == .success ? out : nil
    }

    static var granted: Bool { AXIsProcessTrusted() }

    /**
     Leave the answer where something else can read it.

     Whether the app is trusted is a fact only the app can establish:
     `AXIsProcessTrusted` speaks for the calling process, TCC's database is
     itself protected, and the helper run from a terminal is attributed to the
     terminal — so all three of the obvious ways to check from outside report
     something other than the truth. Writing it down turns "press the hotkey and
     tell me what it says" into a question anybody can answer.
     */
    static func recordTrust() {
        let dir = NSHomeDirectory() + "/Library/Application Support/Talaria"
        let payload: [String: Any] = [
            "granted": AXIsProcessTrusted(),
            "at": ISO8601DateFormatter().string(from: Date()),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: URL(fileURLWithPath: dir + "/accessibility.json"), options: .atomic)
    }

    /**
     Applications that draw their own text, and how to ask them instead.

     The accessibility tree only has words if the application put them there.
     TextEdit does, and so does a Gmail compose box, because both use real text
     controls. Word draws its document itself and exposes nothing; Google Docs
     renders to a canvas and is worse — its title is reachable and its body is
     not, which is why searching only works there when the name of the thing
     happens to be in the filename.

     Word is scriptable, though, with a full dictionary. So for the few
     applications where this is true, ask in the language they do answer.
     Deliberately a short named list rather than a general "try AppleScript on
     anything": every first attempt raises a permission prompt naming the target
     application, and a tool that asks to control everything on the machine
     deserves to be refused.
     */
    private static let scripted: [String: String] = [
        "com.microsoft.Word": """
        tell application "Microsoft Word"
          if (count of documents) is 0 then return ""
          return content of text object of active document
        end tell
        """,
    ]

    /// The focused element's text: a selection if there is one, else its value.
    static func text() -> String? {
        guard AXIsProcessTrusted() else { return nil }
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        if let focused = attr(axApp, kAXFocusedUIElementAttribute as String) {
            let element = unsafeBitCast(focused, to: AXUIElement.self)
            // A highlight is a stronger statement of what somebody means than
            // the whole document is, so it wins.
            for name in [kAXSelectedTextAttribute, kAXValueAttribute] {
                if let v = attr(element, name as String) as? String,
                   !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return String(v.prefix(maxChars))
                }
            }
        }

        // Nothing in the tree. Ask the ones that answer another way.
        if let id = app.bundleIdentifier, let source = scripted[id] {
            return script(source)
        }
        return nil
    }

    /// Run one of the scripts above, and treat every failure as silence.
    private static func script(_ source: String) -> String? {
        guard let s = NSAppleScript(source: source) else { return nil }
        var err: NSDictionary?
        let out = s.executeAndReturnError(&err)
        if err != nil { return nil }
        guard let text = out.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return nil }
        return String(text.prefix(maxChars))
    }
}

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
    /// Whether undated hits belong below the fold. Read from config.json rather
    /// than held, so a change in Settings shows up on the next hotkey press
    /// instead of at the next login.
    @Published var undatedFurtherOut = false

    func reloadSettings() {
        undatedFurtherOut = ConfigStore.load().glanceUndatedFurtherOut
    }

    private var watch: Timer?

    /// Ask about whatever is in front, unless something has been typed.
    func refresh() {
        busy = true
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        // Read here, on the main actor, before the fetch goes off the thread —
        // and by the app, which is what holds the accessibility grant. Sending
        // it as the question means the daemon never has to reach for the
        // document itself, and the words still go no further than this machine.
        Focused.recordTrust()
        let document = typed.isEmpty ? Focused.text() : nil
        Task.detached(priority: .userInitiated) { [weak self] in
            let ask = typed.isEmpty ? document : typed
            let answer = try? Daemon.glance(query: ask)
            await MainActor.run {
                guard let self else { return }
                self.busy = false
                guard let answer else {
                    self.error = "the daemon isn't answering"
                    return
                }
                self.hits = answer.data
                self.question = answer.question
                // The daemon reports where *it* got the question; when the app
                // supplied one it calls that "asked", which would be a lie
                // about a document nobody typed into a search box.
                self.source = document != nil ? "document" : answer.source
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
        reloadSettings()
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
    /// Whether the things dated outside the window are showing.
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.35)
            if let error = model.error {
                message(error)
            } else if model.hits.isEmpty {
                // Say which of the three it is. "Nothing close" and "I am not
                // allowed to look" are different problems with different
                // answers, and a panel that shows the same empty state for both
                // sends somebody hunting through their library for a fault that
                // is in System Settings.
                if !Focused.granted {
                    message("Talaria can't read what you're working on.\n\nSystem Settings → Privacy & Security → Accessibility, and add Talaria.")
                } else {
                    message(model.question == nil
                            ? "Nothing in front worth asking about."
                            : "Nothing close to this yet.")
                }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(near) { hit in row(hit) }

                        // Said rather than hidden. A filter whose contents you
                        // cannot see is one you have no reason to distrust: if
                        // the letter to Milton were dated six weeks out you
                        // would conclude Glance did not know about it and go
                        // hunting in Hermes. One line removes that entirely,
                        // and the scores stay visible so it is obvious these
                        // are further out rather than worse matches.
                        if !later.isEmpty {
                            Button { expanded.toggle() } label: {
                                HStack(spacing: 6) {
                                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 8, weight: .semibold))
                                    Text(expanded
                                         ? foldLabel
                                         : "\(later.count) \(foldLabel)")
                                        .font(.system(size: 10, weight: .medium))
                                    Rectangle()
                                        .fill(Color.primary.opacity(0.08))
                                        .frame(height: 0.5)
                                }
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 12)
                                .padding(.top, 8)
                                .padding(.bottom, 4)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            if expanded {
                                ForEach(later) { hit in row(hit) }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .frame(width: 380, height: 420)
        .background(VisualEffect(radius: 16))
        .overlay(
            // A hairline rather than a border. It is what separates the panel
            // from a light document behind it; any heavier and the thing starts
            // looking like a dialog again.
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
        )
    }

    /// What is happening around now — plus everything undated, unless the
    /// reader has asked for those below the line instead.
    private var near: [Daemon.GlanceHit] {
        model.hits.filter { $0.isAbove(theFold: model.undatedFurtherOut) }
    }

    /// Everything else. Still ranked, still scored, one click away.
    private var later: [Daemon.GlanceHit] {
        model.hits.filter { !$0.isAbove(theFold: model.undatedFurtherOut) }
    }

    /// What the divider calls what is under it. Naming undated things only when
    /// some of them are actually down there — a line reading "further out or
    /// undated" above three dated tasks is a small lie about what it hides.
    private var foldLabel: String {
        model.undatedFurtherOut && later.contains { !$0.isDated }
            ? "further out or undated"
            : "further out"
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

            Spacer(minLength: 6)

            // How near it is, in the order the list is already in. Worth showing
            // because similarity has no wrong answers, only worse ones: a list
            // that ends at 0.31 looks the same as one that ends at 0.72 until
            // the number is there, and knowing the difference is what tells you
            // whether the top hit means anything.
            Text(String(format: "%.2f", hit.score))
                .font(.system(size: 10, weight: .medium, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
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

/**
 The material behind it.

 `.hudWindow` was the first attempt and it reads as a HUD from about 2012 —
 heavy, dark, obviously a thing an application put on your screen. `.popover` is
 the material the system itself uses for menu-bar popovers and inspectors, so a
 panel wearing it looks like part of the machine rather than a guest on it.

 `.behindWindow` is what makes it genuinely translucent: the blur samples the
 windows underneath rather than its own background, which is why the colour of
 whatever you are working in comes through it.

 The rounding lives here rather than in SwiftUI. A borderless window with a
 clear background derives its shadow from the shape of its opaque content — clip
 the content in SwiftUI and the window still believes it is a rectangle, so the
 shadow is drawn square behind a rounded panel. Masking the effect view itself
 gives the window a real shape to cast from.
 */
struct VisualEffect: NSViewRepresentable {
    var radius: CGFloat = 16

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .popover
        v.blendingMode = .behindWindow
        v.state = .active
        // Not emphasized: emphasis is for the window somebody is working in,
        // and this one is deliberately never that.
        v.isEmphasized = false
        v.wantsLayer = true
        v.layer?.cornerRadius = radius
        v.layer?.cornerCurve = .continuous
        v.layer?.masksToBounds = true
        return v
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.layer?.cornerRadius = radius
    }
}
