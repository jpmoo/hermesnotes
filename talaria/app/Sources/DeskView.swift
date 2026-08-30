import AppKit
import SwiftUI
import WebKit

/**
 The desk: everything at once, over whatever you were doing.

 The other panels are each about one thing and are summoned when you want that
 thing. This is the opposite move — a full screen, frosted over what is behind
 it, with the four surfaces in quadrants. It is for the moment between things,
 when the question is not "what did I write about this" but "where was I".

 Deliberately not a window you keep. It covers the screen, so it is a place you
 go and leave; Escape and a click outside both dismiss it, the same as every
 other panel here.
 */

// MARK: - The page for today

/**
 Today's scratchpad, live.

 The one surface here that reaches past the interchange binding, and the only
 one entitled to: a daily note is Hermes' own idea. The format has no word for
 "the page for a date" — it is `LIMITS.md`'s third open entry — so there is
 nothing to be spec-compliant *with*, and pretending otherwise would mean
 inventing a private extension and calling it a standard.

 Read live rather than from the mirror, because this is a thing being typed
 into. A copy thirty seconds behind would overwrite whatever somebody wrote in
 the web app while they were looking at it here.
 */
@MainActor
final class ScratchpadModel: ObservableObject {
    @Published var loading = true
    @Published var status: String?
    @Published var date = ""
    /// The block's own page in Hermes. Everything else here exists to find it.
    @Published var pageURL: URL?
    /// How many times the desk has been opened. The web view reloads when this
    /// moves, which is what makes a stale page impossible without making an
    /// in-progress sentence impossible too.
    @Published var generation = 0

    private var id: String?
    private var version = 0
    /// What the server last confirmed. A save is worth doing when this and
    /// `text` differ, and not otherwise — which is what stops an idle panel
    /// writing the same page back every two seconds.

    func load() {
        loading = true
        generation += 1
        Task.detached(priority: .userInitiated) { [weak self] in
            let got = try? Daemon.scratchpad()
            await MainActor.run {
                guard let self else { return }
                self.loading = false
                guard let got else {
                    self.status = "can't reach Hermes"
                    return
                }
                self.id = got.id
                self.version = got.version
                self.date = got.date
                self.status = nil
                // The embed route, not the block's ordinary page.
                //
                // `/block/<id>` is the whole application around one block — a
                // sidebar, a nav bar, a right panel and, for a daily note, the
                // day's hero image and every other section of it. In a quarter
                // of a laptop screen that is mostly furniture. `/embed/…`
                // renders the same editor with none of it.
                //
                // By date rather than by id: the scratchpad is a different block
                // every day, and letting the far end find today's note is one
                // fewer thing to be stale.
                if let origin = (try? Daemon.health())?.origin {
                    let base = origin.hasSuffix("/") ? String(origin.dropLast()) : origin
                    self.pageURL = URL(string: base + "/embed/scratchpad/" + got.date)
                }
            }
        }
    }

    /// Nothing to save from here.
    ///
    /// The editor in the web view writes through Hermes' own routes, on its
    /// own schedule. That is the point of embedding it rather than copying it,
    /// and the reason this model holds no text: two things writing one block on
    /// two timers is how a paragraph goes missing.
    func flush() {}
}

/**
 The scratchpad, as Hermes draws it.

 A `TextEditor` was the first version and it was wrong in a way worth naming:
 the page is markdown, and in Hermes it renders — headings, checkboxes, the `@`
 and `#` pickers, piping into a block. A plain text box shows you the source of
 all that and lets you type none of it, which is not "the scratchpad" but a
 different, worse thing wearing its name.

 Reimplementing that editor here would be weeks of work whose only possible
 outcome is a second editor that drifts from the first. So this is the first
 one: a web view on the block's own page in Hermes, which is the same editor
 the browser gets, with the same features, saving through the same route.

 It shares the cookie store with the Hermes Notes window, so it is already
 signed in — and it *is* the sync, so there is no version to reconcile and
 nothing for this app to write back.
 */
private struct HermesEmbed: NSViewRepresentable {
    let url: URL
    /// Bumped every time the desk opens. See `updateNSView`.
    let generation: Int

    final class Coordinator {
        var loaded: Int = -1
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // The same store as `HermesWindow`, which is what makes this signed in
        // rather than a login form in the corner of the desk.
        config.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        // Once per opening, and not once per SwiftUI update.
        //
        // The panel is built once and kept, so the web view inside it outlives
        // any number of openings — which meant it loaded the page on the first
        // ⌥⇧T and never again. A day rolling over, a note edited in the browser,
        // or the application itself being redeployed all left this showing
        // something from hours ago. Reloading on every update instead would
        // throw away what somebody was typing, several times a second.
        //
        // So it is tied to the count of openings: a fresh look each time the
        // desk appears, and never while it is up.
        guard context.coordinator.loaded != generation || view.url == nil else { return }
        context.coordinator.loaded = generation
        view.load(URLRequest(url: url))
    }
}

private struct ScratchpadPane: View {
    @ObservedObject var model: ScratchpadModel

    var body: some View {
        DeskPane(title: "Scratchpad", subtitle: model.date, note: model.status) {
            if let url = model.pageURL {
                HermesEmbed(url: url, generation: model.generation)
            } else if model.loading {
                DeskPlaceholder("reading today's page")
            } else {
                DeskPlaceholder(model.status ?? "no page for today")
            }
        }
    }
}

// MARK: - Where you were

/**
 The workspaces, as pictures.

 A tiling manager parks the workspace you are not on off-screen rather than
 destroying it, and macOS keeps a backing store for a window whether or not it
 is being drawn. So a workspace nobody is looking at can still be photographed,
 which is the whole reason this can show you where you were rather than a list
 of names.

 Screen Recording is what that costs. Without it the capture returns nothing and
 the tile falls back to the icons of the applications in that workspace — which
 is less than a picture and still tells you which one is your mail.
 */
@MainActor
final class WorkspacesModel: ObservableObject {
    @Published var spaces: [Daemon.Workspace] = []
    @Published var shots: [String: NSImage] = [:]
    @Published var loading = true
    @Published var denied = false

    /// Whether the prompt has been put up this launch. macOS shows it once and
    /// then quietly refuses; asking on every open would be a panel that appears
    /// to do nothing, repeatedly.
    private static var asked = false

    func load() {
        loading = true
        // Preflight rather than assume: this returns false the first time and
        // the request puts up the system prompt. Both are cheap and neither
        // captures anything.
        if !CGPreflightScreenCaptureAccess() && !Self.asked {
            Self.asked = true
            _ = CGRequestScreenCaptureAccess()
        }
        Task.detached(priority: .userInitiated) { [weak self] in
            let got = (try? Daemon.workspaces()) ?? []
            await MainActor.run {
                guard let self else { return }
                self.spaces = got
                self.loading = false
            }
            // Pictures after names. The list is the useful part and arrives in
            // milliseconds; a capture is tens of them per window, and making the
            // panel wait for all of them would be the difference between opening
            // and appearing to hang.
            for space in got {
                guard let shot = Self.picture(of: space) else { continue }
                await MainActor.run { self?.shots[space.name] = shot }
            }
            await MainActor.run { self?.denied = (self?.shots.isEmpty ?? true) && got.contains { !$0.windows.isEmpty } }
        }
    }

    /// The largest window in a workspace, which is the one that says where you
    /// were. Compositing every window into a little diagram was the other
    /// option and it produces a picture of a layout rather than of work.
    nonisolated private static func picture(of space: Daemon.Workspace) -> NSImage? {
        var best: NSImage?
        var bestArea: CGFloat = 0
        for window in space.windows {
            guard
                let shot = CGWindowListCreateImage(
                    .null,
                    .optionIncludingWindow,
                    CGWindowID(window.id),
                    [.boundsIgnoreFraming, .nominalResolution]
                )
            else { continue }
            let area = CGFloat(shot.width * shot.height)
            if area > bestArea {
                bestArea = area
                best = NSImage(cgImage: shot, size: NSSize(width: shot.width, height: shot.height))
            }
        }
        return best
    }

    func focus(_ name: String) {
        Task.detached(priority: .userInitiated) { _ = try? Daemon.focusWorkspace(name) }
    }
}

private struct WorkspacesPane: View {
    @ObservedObject var model: WorkspacesModel
    var onPick: (String) -> Void

    private static let gap: CGFloat = 10
    private static let inset: CGFloat = 8

    var body: some View {
        DeskPane(
            title: "Workspaces",
            subtitle: model.spaces.first(where: { $0.focused })?.name,
            note: model.denied ? "no Screen Recording — grant it in System Settings for pictures" : nil
        ) {
            if model.loading {
                DeskPlaceholder("asking the window manager")
            } else if model.spaces.isEmpty {
                DeskPlaceholder("no window manager answering")
            } else {
                // Filled, not listed.
                //
                // An adaptive grid of fixed-height tiles put four workspaces in
                // a row across the top and left the rest of the quadrant empty,
                // which is a waste of the one pane whose whole job is to be
                // looked at. The shape is computed from how many there are and
                // the tiles take whatever is left over, so the pictures are as
                // large as the space allows — a thumbnail you have to lean
                // towards is not doing anything a label would not.
                GeometryReader { geo in
                    let count = max(1, model.spaces.count)
                    let cols = min(count, max(1, Int(ceil(sqrt(Double(count))))))
                    let rows = Int(ceil(Double(count) / Double(cols)))
                    let usableW = geo.size.width - Self.inset * 2
                    let usableH = geo.size.height - Self.inset * 2
                    let tileW = (usableW - Self.gap * CGFloat(cols - 1)) / CGFloat(cols)
                    let tileH = (usableH - Self.gap * CGFloat(rows - 1)) / CGFloat(rows)
                    VStack(spacing: Self.gap) {
                        ForEach(0..<rows, id: \.self) { row in
                            HStack(spacing: Self.gap) {
                                ForEach(0..<cols, id: \.self) { col in
                                    let i = row * cols + col
                                    if i < model.spaces.count {
                                        tile(model.spaces[i], width: tileW, height: tileH)
                                    } else {
                                        // Keeps the last row aligned with the
                                        // ones above rather than centring three
                                        // tiles under four.
                                        Color.clear.frame(width: tileW, height: tileH)
                                    }
                                }
                            }
                        }
                    }
                    .padding(Self.inset)
                }
            }
        }
    }

    private func tile(_ space: Daemon.Workspace, width: CGFloat, height: CGFloat) -> some View {
        Button {
            onPick(space.name)
        } label: {
            // The picture gets an exact rectangle, not a share of one.
            //
            // `.aspectRatio(.fill)` makes an image larger than its container on
            // purpose, and a clip afterwards changes what is *drawn* and not
            // what is *laid out* — so a wide window's thumbnail still measured
            // wide, pushed its own tile out, and four equal tiles came back
            // unequal. Sizing the frame first and clipping to that is the only
            // arrangement where fill means "cover this" rather than "become this
            // big".
            let caption: CGFloat = 16
            let spacing: CGFloat = 5
            let pictureH = max(24, height - caption - spacing)
            VStack(alignment: .leading, spacing: spacing) {
                ZStack {
                    RoundedRectangle(cornerRadius: 7)
                        .fill(Color.primary.opacity(0.06))
                    if let shot = model.shots[space.name] {
                        Image(nsImage: shot)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else if space.windows.isEmpty {
                        Text("empty")
                            .font(Theme.chrome(10))
                            .foregroundStyle(.tertiary)
                    } else {
                        // No picture: the applications themselves, which is
                        // still enough to recognise a workspace by.
                        HStack(spacing: 4) {
                            ForEach(Array(space.windows.prefix(4).enumerated()), id: \.offset) { _, window in
                                if let icon = Self.icon(for: window.bundleId) {
                                    Image(nsImage: icon).resizable().frame(width: 22, height: 22)
                                }
                            }
                        }
                    }
                }
                .frame(width: width, height: pictureH)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .overlay(
                    RoundedRectangle(cornerRadius: 7)
                        .strokeBorder(space.focused ? Theme.accent : Color.primary.opacity(0.12),
                                      lineWidth: space.focused ? 2 : 1)
                )

                HStack(spacing: 5) {
                    Text(space.name).font(Theme.chrome(11, weight: .medium)).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(space.windows.isEmpty ? "—" : "\(space.windows.count)")
                        .font(Theme.chrome(10))
                        .foregroundStyle(.secondary)
                }
                .frame(width: width, height: caption)
            }
        }
        .buttonStyle(.plain)
        .frame(width: width, height: height)
        .help(space.windows.map(\.app).joined(separator: ", "))
    }

    private static func icon(for bundleId: String?) -> NSImage? {
        guard let bundleId,
              let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
        else { return nil }
        return NSWorkspace.shared.icon(forFile: url.path)
    }
}

// MARK: - Furniture

/// One quadrant: a titled card over the frost.
private struct DeskPane<Content: View>: View {
    let title: String
    var subtitle: String?
    var note: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text(title.uppercased())
                    .font(Theme.chrome(10, weight: .semibold))
                    .foregroundStyle(.secondary)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(Theme.chrome(10)).foregroundStyle(.tertiary).lineLimit(1)
                }
                Spacer(minLength: 0)
                if let note, !note.isEmpty {
                    Text(note).font(Theme.chrome(10)).foregroundStyle(Theme.danger).lineLimit(1)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)

            Divider().opacity(0.4)
            content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        // Each pane takes a quarter of the screen whatever is in it. Without
        // this every card shrank to fit its own contents, so the composer — the
        // one with a form in it — pushed the scratchpad thin and Glance sat in a
        // column a third the width of the space under it.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: Theme.cardRadius)
                .fill(.background.opacity(0.55))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.cardRadius)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius))
        // A child wider than its quadrant is clipped to it. Without this the
        // composer drew over the pane beside it, which looked like two windows
        // overlapping rather than one that did not fit.
        .contentShape(RoundedRectangle(cornerRadius: Theme.cardRadius))
    }
}

private struct DeskPlaceholder: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(Theme.chrome(11))
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - The desk itself

/// What the menu bar and Dock take out of the screen. Observed rather than
/// passed by value because the window is built once and can move to a screen
/// with different chrome.
@MainActor
final class DeskInsets: ObservableObject {
    @Published var top: CGFloat = 0
    @Published var bottom: CGFloat = 0
}

struct DeskView: View {
    @ObservedObject var insets: DeskInsets
    @ObservedObject var scratchpad: ScratchpadModel
    @ObservedObject var workspaces: WorkspacesModel
    @ObservedObject var compose: ComposeModel
    @ObservedObject var glance: GlanceModel
    var onPickWorkspace: (String) -> Void

    private static let gap: CGFloat = 14
    private static let margin: CGFloat = 18

    var body: some View {
        // Measured, not asked for.
        //
        // `maxWidth: .infinity` is a willingness to grow, not an instruction to
        // share: an HStack still hands out space according to what each side
        // says it wants, and these children have opinions — the composer was
        // built for a 480-point panel and Glance for 380 by 420. So the first
        // attempt produced a composer at its natural width, a scratchpad in
        // what was left, and Glance in a column a third the width of the
        // quadrant under it. Dividing the screen here and telling each pane
        // exactly what it gets is the only thing that makes four equal
        // quadrants out of four views with preferences.
        //
        // Each of them already scrolls internally, which is what absorbs the
        // difference when a form is taller than a quarter of a screen.
        // The reader measures what is left after the insets, rather than the
        // whole window with the insets subtracted again inside it. Doing both
        // was the bug: the quadrants were computed correctly and then pushed
        // down by padding that had already been accounted for, so the bottom
        // row ran off the screen by exactly the height of the menu bar.
        GeometryReader { geo in
            let w = (geo.size.width - Self.gap) / 2
            let h = (geo.size.height - Self.gap) / 2
            VStack(spacing: Self.gap) {
                HStack(spacing: Self.gap) {
                    ScratchpadPane(model: scratchpad).frame(width: w, height: h)
                    // The composer and Glance are the panels they always were,
                    // embedded rather than reimplemented. Two copies of a form
                    // that builds itself from a type's declared fields is
                    // precisely the duplication this project keeps not doing.
                    DeskPane(title: "New block") {
                        ComposeView(model: compose)
                    }
                    .frame(width: w, height: h)
                }
                HStack(spacing: Self.gap) {
                    DeskPane(title: "Glance") {
                        GlanceView(model: glance)
                    }
                    .frame(width: w, height: h)
                    WorkspacesPane(model: workspaces, onPick: onPickWorkspace)
                        .frame(width: w, height: h)
                }
            }
        }
        // The frost reaches the edges of the screen; the panes clear the chrome
        // that is drawn over them.
        .padding(.horizontal, Self.margin)
        // The larger of the two, not the sum.
        //
        // Adding a margin on top of the menu bar's height put a 51-point band
        // of bare frost above the first pane — the chrome's height is already
        // the clearance, and a margin as well is a second one. Taking the
        // larger keeps the ordinary inset on a screen with no chrome to clear
        // and sits flush under the menu bar on one that has.
        .padding(.top, max(Self.margin, insets.top))
        .padding(.bottom, max(Self.margin, insets.bottom))
        // AppKit reports a safe area for the title bar of a
        // `fullSizeContentView` window, and SwiftUI honours it — so a second
        // inset of about thirty points was being added under the one this view
        // already applies for the menu bar, and the first pane sat 65 points
        // down instead of 33. The window's chrome is hidden and the clearance
        // is computed here; there is nothing for a safe area to protect.
        .ignoresSafeArea()
    }
}

/**
 A panel that can take the keyboard, and gives it back on Escape.

 A borderless window answers `canBecomeKey` with false unless it is told
 otherwise — the title bar is what AppKit normally takes as the sign that a
 window is meant to be typed into. Which made the desk a picture of itself: the
 scratchpad could not be typed in, the composer's fields could not be focused,
 and Escape did not dismiss it because key events were not being delivered here
 at all.

 `cancelOperation` rather than only the shared dismissal monitor, because that
 is the responder-chain path Escape actually takes once a window *is* key, and a
 panel with a web view in it has a first responder of its own that would
 otherwise be entitled to the keystroke.
 */
final class DeskPanel: NSPanel {
    var onCancel: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onCancel?() }

    /**
     Take the frame that was asked for.

     AppKit moves a *titled* window down so its title bar cannot sit under the
     menu bar. This one is titled only so a tiling manager can see it — the bar
     is hidden and nothing is drawn for it — but the constraint applies anyway:
     asked for the screen's own rectangle, the window came back 33 points lower
     and still a full screen tall, so it hung off the bottom by exactly the
     height of the menu bar and left a band of nothing at the top. Which read as
     two separate layout bugs and was one refusal.

     Overriding this is the documented way to say the window means it.
     */
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}
