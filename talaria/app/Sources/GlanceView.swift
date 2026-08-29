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

    /// The shortest a field's whole contents can be and still be worth asking
    /// about. Not applied to a selection, which is deliberate at any length.
    static let MEANINGFUL = 12

    /**
     Applications this will not look at, at all, for any reason.

     Mirrors `TITLE_BLIND` in `packages/daemon/src/context.ts`, which is
     canonical; `glancecheck` fails the build if the two drift apart, because a
     name missing from this copy is a password manager being read rather than a
     test going red.

     It has to live here, and that is the point. The daemon applies its own copy
     before *its* read, but the daemon is no longer the one reading: the app
     holds the accessibility grant, so the app does the looking and sends the
     result as a question. Anything checked only at the far end is checked after
     the fact — and "we looked and then discarded it" is not the promise. The
     promise is that we did not look.
     */
    static let blind: Set<String> = [
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.apple.keychainaccess",
        "com.bitwarden.desktop",
        "com.lastpass.LastPass",
        "com.apple.Passwords",
        "org.keepassxc.keepassxc",
        "com.apple.Console",
    ]

    private static func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var out: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &out) == .success ? out : nil
    }

    static var granted: Bool { AXIsProcessTrusted() }

    /**
     Whoever was last in front that was not us.

     Tracked rather than asked for, because by the time some of these panels are
     open the answer to "what is frontmost" is Talaria. That is fine for a hotkey
     — nothing activates us, so the front application is still the one somebody
     was working in — and wrong for every other route in: `open talaria://new`
     activates the app *before* delivering the URL, so a selection read at that
     point is a selection in our own empty window.

     One observer, one bundle id, no polling.
     */
    private(set) static var previousApp: NSRunningApplication?

    static func watchFrontmost() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier != Bundle.main.bundleIdentifier
            else { return }
            previousApp = app
        }
    }

    /**
     How long to wait for another application to answer.

     An accessibility read is a synchronous call into a process this one does
     not control, and every one of these runs on the main actor because it has
     to happen before a panel is shown. With no bound, an application that has
     stopped servicing its event loop takes Talaria's UI down with it — Finder
     wedged for several minutes on this machine once, and the symptom would have
     been Glance doing nothing at all, with no crash and nothing in the log.

     The helper binary has had this protection since it was written, for free,
     because the daemon spawns it with a two-second subprocess timeout. The
     in-app reads were added later and inherited nothing.

     Half a second. A window title or a focused field is a value the target
     already holds; anything slower than this is not slow, it is stuck.
     */
    private static let axTimeout: Float = 0.5

    /// The application to read, unless it is one we have promised not to.
    private static func readableFront() -> NSRunningApplication? {
        guard AXIsProcessTrusted() else { return nil }
        let front = NSWorkspace.shared.frontmostApplication
        // Ourselves in front means the question is about whatever we covered up.
        let app = (front?.bundleIdentifier == Bundle.main.bundleIdentifier)
            ? (previousApp ?? front)
            : front
        guard let app else { return nil }
        if let id = app.bundleIdentifier, blind.contains(id) { return nil }
        return app
    }

    /**
     What is selected right now, and only that.

     Distinct from `text()`, which falls back to a whole field's contents when
     nothing is highlighted. A composer seeded with the entire document somebody
     happened to have open would be putting words in their mouth; a composer
     seeded with what they deliberately selected is doing what they asked.

     Read before the panel appears, because showing it changes what is frontmost
     and the selection would be Talaria's own by the time anything asked.
     */
    static func selection() -> String? {
        guard let app = readableFront() else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(axApp, axTimeout)
        guard let focused = attr(axApp, kAXFocusedUIElementAttribute as String) else { return nil }
        let element = unsafeBitCast(focused, to: AXUIElement.self)
        guard let v = attr(element, kAXSelectedTextAttribute as String) as? String else { return nil }
        let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : String(t.prefix(maxChars))
    }

    /**
     The focused window's own title.

     Needed because neither thing the daemon could ask has it. `lsappinfo`
     answers with the application's display name — its record's leading quoted
     token is the name field, so a Chrome window showing a letter to Milton
     reported "Google Chrome" and Glance dutifully went looking for that. Rift
     has real titles but only for windows it manages, and answers null for
     plenty of them.

     The accessibility tree has it for everything, and this process is already
     the one holding the grant.
     */
    static func windowTitle() -> String? {
        guard let app = readableFront() else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(axApp, axTimeout)
        guard let raw = attr(axApp, kAXFocusedWindowAttribute as String) else { return nil }
        let window = unsafeBitCast(raw, to: AXUIElement.self)
        guard let title = attr(window, kAXTitleAttribute as String) as? String else { return nil }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : String(trimmed.prefix(maxChars))
    }

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
        guard let app = readableFront() else { return nil }

        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(axApp, axTimeout)
        if let focused = attr(axApp, kAXFocusedUIElementAttribute as String) {
            let element = unsafeBitCast(focused, to: AXUIElement.self)

            // A highlight is a stronger statement of what somebody means than
            // the whole document is, so it wins, and at any length: two words
            // deliberately selected are a real question.
            if let v = attr(element, kAXSelectedTextAttribute as String) as? String {
                let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { return String(t.prefix(maxChars)) }
            }

            // A field's whole contents are incidental rather than chosen, so
            // they have to be worth something before they beat the window title.
            //
            // Google Docs is the case that forces this. Its focused element is
            // an off-screen input one pixel tall holding a two-character window
            // around the cursor — the document itself is on a canvas and is
            // never in the tree. Without a floor, Glance would take "no" as the
            // document, embed it, and return nonsense with every appearance of
            // having read something.
            if let v = attr(element, kAXValueAttribute as String) as? String {
                let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
                if t.count >= MEANINGFUL { return String(t.prefix(maxChars)) }
            }
        }

        // Nothing in the tree. Ask the ones that answer another way.
        if let id = app.bundleIdentifier, let source = scripted[id] {
            return script(source)
        }
        return nil
    }

    /**
     Run one of the scripts above.

     Every failure is silence to the caller — Glance falls back to the window
     title, which is the right behaviour — but it is no longer silence in the
     log. Treating "not permitted" the same as "no document open" is what made
     an unentitled binary indistinguishable from Word simply having nothing to
     say, and -1743 in particular has a specific cause and a specific fix.
     */
    private static func script(_ source: String) -> String? {
        guard let s = NSAppleScript(source: source) else { return nil }
        var err: NSDictionary?
        let out = s.executeAndReturnError(&err)
        if let err {
            let code = (err[NSAppleScript.errorNumber] as? Int) ?? 0
            let why = (err[NSAppleScript.errorMessage] as? String) ?? "\(err)"
            switch code {
            case -1743:
                NSLog("talaria: not permitted to send Apple Events (-1743). The bundle needs com.apple.security.automation.apple-events, or Talaria needs ticking under Privacy & Security → Automation.")
            case -600, -609:
                break // that application simply is not running
            default:
                NSLog("talaria: AppleScript failed (\(code)) — \(why)")
            }
            return nil
        }
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
    /// What the document is *called*, when the question came from inside it.
    ///
    /// Shown beside the question rather than instead of it. Glance asks about a
    /// document's contents by preference — that is the whole point, since an
    /// untitled draft is exactly when you cannot find the note you are reaching
    /// for — but one truncated line of body text sitting next to a small
    /// "document" badge reads like a filename, and got read as one.
    @Published var documentName: String?
    @Published var error: String?
    @Published var busy = false
    /// What the person typed, when they want to ask something other than the window.
    @Published var query = ""
    /// Whether undated hits belong below the fold. Read from config.json rather
    /// than held, so a change in Settings shows up on the next hotkey press
    /// instead of at the next login.
    @Published var undatedFurtherOut = false
    /// Below this, a hit is "less similar" rather than a hit. Zero is off.
    @Published var threshold = 0.0
    /// Whether finished things get their own section.
    @Published var separateDone = false

    func reloadSettings() {
        let c = ConfigStore.load()
        undatedFurtherOut = c.glanceUndatedFurtherOut
        threshold = c.glanceThreshold
        separateDone = c.glanceSeparateDone
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
        // The window's own title. Read here rather than left to the daemon:
        // what the daemon can reach is the application's *name*, which is how
        // Glance came to spend a fortnight asking the library about "Google
        // Chrome".
        //
        // Read even when the document answered, because then it is not the
        // question — it is the answer to "which document?", which the question
        // alone cannot give you once it is a line of prose.
        let title = typed.isEmpty ? Focused.windowTitle() : nil
        Task.detached(priority: .userInitiated) { [weak self] in
            let ask = typed.isEmpty ? (document ?? title) : typed
            // Only worth naming when the question came from inside the
            // document. When the title *is* the question, printing it twice
            // says nothing.
            let named = document != nil ? title : nil
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
                self.source = document != nil ? "document" : (title != nil ? "title" : answer.source)
                self.documentName = named
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
    /// Which of the folded sections are open. Independent, because opening
    /// "further out" to find a date should not also unfurl everything the
    /// embedder scored badly.
    @State private var open: Set<Daemon.GlanceSection> = []

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
                        let filed = sections
                        ForEach(filed[.main] ?? []) { hit in row(hit) }

                        // Said rather than hidden, and this is the whole reason
                        // the sections are dividers instead of a filter. A
                        // filter whose contents you cannot see is one you have
                        // no reason to distrust: if the letter to Milton were
                        // dated six weeks out, or scored a hair under the
                        // threshold, you would conclude Glance did not know
                        // about it and go hunting in Hermes. One line each
                        // removes that, and the scores stay visible so it is
                        // obvious which of the three reasons applied.
                        //
                        // Ordered by how much attention the thing has earned:
                        // wrong time, then weak match, then already finished.
                        ForEach([Daemon.GlanceSection.furtherOut, .lessSimilar, .done], id: \.self) { section in
                            let hits = filed[section] ?? []
                            if !hits.isEmpty {
                                fold(section, hits)
                                // Opened when the reader asked, and also when
                                // the main list came back empty and this is the
                                // best there is.
                                //
                                // Every section folded and nothing above them
                                // is a panel that has found sixteen things and
                                // shows a person none of them — three clicks
                                // from an answer, looking exactly like a panel
                                // that found nothing. A fold is for demoting
                                // what you probably do not want under what you
                                // probably do; with nothing above it, it is
                                // just hiding.
                                if open.contains(section) || firstOpen == section {
                                    ForEach(hits) { hit in row(hit) }
                                }
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

    /// Every hit, filed once. Computed together so a hit cannot appear twice —
    /// the sections are a partition, not four independent filters.
    private var sections: [Daemon.GlanceSection: [Daemon.GlanceHit]] {
        Dictionary(grouping: model.hits) {
            Daemon.GlanceSection.of(
                $0,
                undatedBelow: model.undatedFurtherOut,
                threshold: model.threshold,
                separateDone: model.separateDone
            )
        }
    }

    /// What each divider calls what is under it.
    ///
    /// "Further out" names undated things only when some are actually down
    /// there — a line reading "further out or undated" above three dated tasks
    /// is a small lie about what it hides.
    private func label(_ section: Daemon.GlanceSection, _ hits: [Daemon.GlanceHit]) -> String {
        switch section {
        case .furtherOut:
            return model.undatedFurtherOut && hits.contains { !$0.isDated }
                ? "further out or undated"
                : "further out"
        case .lessSimilar:
            return "less similar"
        case .done:
            return "done"
        case .main:
            return ""
        }
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
                if let name = model.documentName {
                    Text(name)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .layoutPriority(1)
                    Text("·")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
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

    /// The section to unfold when the main list is empty: the first one that has
    /// anything in it, in the order they are shown. Nil whenever the main list
    /// has content, so this never overrides what somebody has actually clicked.
    private var firstOpen: Daemon.GlanceSection? {
        let filed = sections
        guard (filed[.main] ?? []).isEmpty else { return nil }
        return [Daemon.GlanceSection.furtherOut, .lessSimilar, .done]
            .first { !(filed[$0] ?? []).isEmpty }
    }

    /// One collapsible divider.
    private func fold(_ section: Daemon.GlanceSection, _ hits: [Daemon.GlanceHit]) -> some View {
        let isOpen = open.contains(section) || firstOpen == section
        let name = label(section, hits)
        return Button {
            if isOpen { open.remove(section) } else { open.insert(section) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                    .font(.system(size: 8, weight: .semibold))
                Text(isOpen ? name : "\(hits.count) \(name)")
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
