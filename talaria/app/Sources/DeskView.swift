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

 The one surface here that reaches past the interchange binding, and the reason
 is worth stating correctly, because the obvious reason is the wrong one.

 It is not that the format cannot say "the page for a date". That is a real gap
 — `LIMITS.md`'s third open entry — and it is not what forced this. What forced
 it is that the page renders: markdown, checkboxes, the `@` and `#` pickers,
 piping into a block. Reimplementing that in Swift would be weeks of work whose
 only possible outcome is a second editor that drifts from the first, so this
 embeds the first one. A format could have handed over the *content* of today's
 note and it would not have helped, because the content was never the hard part.

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
            await MainActor.run { self?.denied = (self?.shots.isEmpty ?? true) && got.contains { !Self.others($0).isEmpty } }
        }
    }

    /// The largest window in a workspace, which is the one that says where you
    /// were. Compositing every window into a little diagram was the other
    /// option and it produces a picture of a layout rather than of work.
    /**
     What is in a workspace, not counting us.

     The desk is a real window in whichever workspace it was opened in — it has
     to be, or the tiling manager cannot see it and will not leave it alone — and
     it covers the screen, which made it the largest window in the focused
     workspace and therefore the one photographed. So the tile for the workspace
     you are in showed a picture of the panel you were looking at, nested inside
     itself.

     Our own windows are dropped from the count and the icons as well, for the
     same reason: a workspace's tile should say what is there to go back to, and
     this app's panels are not that.
     */
    nonisolated static func others(_ space: Daemon.Workspace) -> [Daemon.WorkspaceWindow] {
        let mine = Bundle.main.bundleIdentifier
        return space.windows.filter { $0.bundleId != mine }
    }

    nonisolated private static func picture(of space: Daemon.Workspace) -> NSImage? {
        var best: NSImage?
        var bestArea: CGFloat = 0
        for window in others(space) {
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
                    // A hollow in the surface rather than a panel on top of
                    // it: at 0.06 of the foreground colour an empty tile reads
                    // as a recess, and the frost behind still shows.
                    RoundedRectangle(cornerRadius: 7)
                        .fill(Color.primary.opacity(0.04))
                    if let shot = model.shots[space.name] {
                        // A photograph is opaque by nature, and four of them at
                        // full strength turned this quadrant into a contact
                        // sheet stuck to the glass. Slightly sunk into the
                        // surface instead — still legible as a picture of a
                        // workspace, no longer the brightest thing on the desk.
                        Image(nsImage: shot)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .opacity(0.82)
                    } else if WorkspacesModel.others(space).isEmpty {
                        Text("empty")
                            .font(Theme.chrome(10))
                            .foregroundStyle(.tertiary)
                    } else {
                        // No picture: the applications themselves, which is
                        // still enough to recognise a workspace by.
                        HStack(spacing: 4) {
                            ForEach(Array(WorkspacesModel.others(space).prefix(4).enumerated()), id: \.offset) { _, window in
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
                    Text(WorkspacesModel.others(space).isEmpty ? "—" : "\(WorkspacesModel.others(space).count)")
                        .font(Theme.chrome(10))
                        .foregroundStyle(.secondary)
                }
                .frame(width: width, height: caption)
            }
        }
        .buttonStyle(.plain)
        .frame(width: width, height: height)
        .help(WorkspacesModel.others(space).map(\.app).joined(separator: ", "))
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
    /// Whether what is behind the window shows through this pane.
    ///
    /// Scoped to the pane rather than to the desk: the frost is the point of the
    /// overlay, and the one place somebody wants it gone is the surface they are
    /// working *on* — a canvas with a stranger's window ghosting through it is
    /// a canvas with something drawn on it that nobody drew.
    var opaque = false
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
                // Enough to hold text against a busy desktop and no more. At
                // 0.55 the panes read as four opaque cards over a blur; the
                // point of the frost is that you can still see roughly what is
                // behind it. Opaque only where somebody has asked for it.
                .fill(opaque ? AnyShapeStyle(Color(nsColor: .windowBackgroundColor))
                             : AnyShapeStyle(.background.opacity(0.35)))
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

/**
 The strip along the bottom: which surface, and a way to change it.

 Hidden until a swipe asks for it, because the desk is four surfaces of somebody
 else's work and a permanent row of chrome under them is a row of chrome they
 did not ask for. A swipe is the gesture that moves between pages, so a swipe is
 also what admits that there is more than one.
 */
private struct SurfaceStrip: View {
    @ObservedObject var chrome: DeskChrome

    var body: some View {
        HStack(spacing: 4) {
            ForEach(DeskSurface.allCases, id: \.rawValue) { surface in
                Button { chrome.go(to: surface) } label: {
                    Image(systemName: surface.symbol)
                        .font(.system(size: 13, weight: .medium))
                        .frame(width: 34, height: 26)
                        .contentShape(Rectangle())
                        .foregroundStyle(chrome.surface == surface ? Theme.accent : Color.secondary)
                        .background(
                            RoundedRectangle(cornerRadius: 7)
                                .fill(chrome.surface == surface ? Color.primary.opacity(0.08) : .clear)
                        )
                }
                .buttonStyle(.plain)
                .help(surface.name)
            }
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 4)
        .background(
            Capsule().fill(.background.opacity(0.55))
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
        )
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }
}

struct DeskView: View {
    @ObservedObject var insets: DeskInsets
    @ObservedObject var chrome: DeskChrome
    @ObservedObject var scratchpad: ScratchpadModel
    @ObservedObject var workspaces: WorkspacesModel
    @ObservedObject var compose: ComposeModel
    @ObservedObject var glance: GlanceModel
    var onPickWorkspace: (String) -> Void

    private static let gap: CGFloat = 14
    private static let margin: CGFloat = 18

    var body: some View {
        // The reader measures what is left after the insets, rather than the
        // whole window with the insets subtracted again inside it. Doing both
        // was the bug: the quadrants were computed correctly and then pushed
        // down by padding that had already been accounted for, so the bottom
        // row ran off the screen by exactly the height of the menu bar.
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                // Both surfaces exist at once, side by side, and the pair is
                // slid. Building the incoming one at the moment of the swipe
                // would mean animating a view still deciding how big it is, and
                // the canvas would arrive a frame late every time.
                HStack(spacing: 0) {
                    quadrants(w: (geo.size.width - Self.gap) / 2,
                              h: (geo.size.height - Self.gap) / 2)
                        .frame(width: geo.size.width, height: geo.size.height)
                    // A region, like a quadrant, filling the page instead of a
                    // quarter of it. The canvas needs an edge for the same
                    // reason the panes do: without one it is the whole screen
                    // and there is nothing to say where the surface stops and
                    // the desktop showing through it begins.
                    DeskPane(title: "Canvas", opaque: !chrome.seeThrough) {
                        CanvasSurface(chrome: chrome)
                    }
                    .overlay(alignment: .bottomTrailing) {
                        CanvasControls(chrome: chrome).padding(14)
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                }
                .frame(width: geo.size.width * 2, alignment: .leading)
                .offset(x: -CGFloat(chrome.surface.rawValue) * geo.size.width)
                // Pinned to the left and cut to one page.
                //
                // A frame twice as wide as its parent is *centred* in it by
                // default, so the first attempt showed the right half of the
                // desk beside the left half of the canvas and looked like a
                // rendering fault rather than a pager. The offset only means
                // "one page along" if the pair starts flush with the leading
                // edge, and the clip is what stops the other page being drawn
                // over the strip.
                .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
                .clipped()

                if chrome.stripShowing {
                    SurfaceStrip(chrome: chrome)
                        .padding(.bottom, 10)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
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

    /**
     The four panes.

     Lifted out of `body` when the desk gained a second surface: a pager and a
     quadrant layout in one expression is two things nobody can read at once.

     `maxWidth: .infinity` is a willingness to grow, not an instruction to
     share — an HStack hands out space according to what each side says it
     wants, and these children have opinions. So each pane is told exactly what
     it gets, and absorbs the difference in its own scroll view.
     */
    @ViewBuilder
    private func quadrants(w: CGFloat, h: CGFloat) -> some View {
        VStack(spacing: Self.gap) {
            HStack(spacing: Self.gap) {
                ScratchpadPane(model: scratchpad).frame(width: w, height: h)
                // The composer and Glance are the panels they always were,
                // embedded rather than reimplemented. Two copies of a form that
                // builds itself from a type's declared fields is precisely the
                // duplication this project keeps not doing.
                DeskPane(title: "New block") {
                    ComposeView(model: compose, standalone: false)
                }
                .frame(width: w, height: h)
            }
            HStack(spacing: Self.gap) {
                DeskPane(title: "Glance") {
                    GlanceView(model: glance, standalone: false)
                }
                .frame(width: w, height: h)
                WorkspacesPane(model: workspaces, onPick: onPickWorkspace)
                    .frame(width: w, height: h)
            }
        }
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

// MARK: - Which surface is showing

/**
 The desk has more than one surface now, and this is which.

 A page rather than a mode: the quadrants and the canvas are both the desk, and
 moving between them is lateral. Nothing about the panel, the frost, the hotkey
 or the dismissal changes with it.
 */
enum DeskSurface: Int, CaseIterable {
    case quadrants
    case canvas

    var symbol: String {
        switch self {
        case .quadrants: return "square.grid.2x2"
        case .canvas: return "point.topleft.down.curvedto.point.bottomright.up"
        }
    }

    var name: String {
        switch self {
        case .quadrants: return "Desk"
        case .canvas: return "Canvas"
        }
    }
}

/**
 What the desk is showing, and how it is drawn.

 Held outside the view so the scroll monitor in the app delegate can push a
 swipe into it without owning the view hierarchy, and so the settings survive
 the panel being hidden and shown again.
 */
@MainActor
final class DeskChrome: ObservableObject {
    @Published var surface: DeskSurface = .quadrants
    /// The strip is out of the way until asked for. A swipe asks.
    @Published var stripShowing = false
    /// A dotted grid under the canvas, off by default: an empty canvas with a
    /// grid on it looks like a thing that is loading.
    @Published var grid = false
    /// Whether the windows behind show through. On is the point of the frost;
    /// off is for when the canvas is the work and the desktop is a distraction.
    @Published var seeThrough = true
    @Published var zoom: CGFloat = 1
    @Published var pan: CGSize = .zero

    private var hideStrip: Timer?

    /// A horizontal two-finger swipe, in points. Positive is content moving
    /// right — a finger travelling left to right.
    func swiped(by dx: CGFloat) {
        reveal()
        // Enough to be a decision rather than a wobble on the way to scrolling
        // something else.
        guard abs(dx) > 60 else { return }
        let next = dx < 0 ? 1 : -1
        let all = DeskSurface.allCases
        guard let at = all.firstIndex(of: surface) else { return }
        let to = min(max(at + next, 0), all.count - 1)
        guard to != at else { return }
        withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { surface = all[to] }
    }

    /// Show the strip and start it fading again. Any further swipe resets the
    /// clock, so it stays up for as long as somebody is moving between things.
    func reveal() {
        if !stripShowing { withAnimation(.easeOut(duration: 0.18)) { stripShowing = true } }
        hideStrip?.invalidate()
        hideStrip = Timer.scheduledTimer(withTimeInterval: 2.6, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                withAnimation(.easeIn(duration: 0.3)) { self?.stripShowing = false }
            }
        }
    }

    func go(to surface: DeskSurface) {
        reveal()
        withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) { self.surface = surface }
    }

    /**
     The desk has been put away.

     Which surface you were on is kept, deliberately and explicitly: closing the
     desk on the canvas and reopening it on the quadrants would make ⌥⇧T a way of
     losing your place. So is the canvas viewport, and so are the grid and
     transparency switches — those are settings, and a setting that forgets is
     not one.

     This lives only as long as the app does. Nothing here is written to disk,
     because "where I was" is a fact about an afternoon rather than about a
     person, and a canvas restored to yesterday's corner on Monday morning is
     furniture nobody asked for.

     What is *not* kept is the strip. It is up because somebody just swiped, and
     a desk reopened hours later opening with a row of chrome already showing —
     and a timer left over from the last session about to fade it — is the state
     of a gesture that is long over.
     */
    func closed() {
        hideStrip?.invalidate()
        hideStrip = nil
        stripShowing = false
    }

    func zoom(to value: CGFloat) {
        // Far enough out to lose a big drawing and far enough in to work on a
        // detail, and no further: past these the pan arithmetic stops being
        // something a person can steer.
        zoom = min(max(value, 0.15), 6)
    }
}

// MARK: - The canvas

/**
 The pointer, said in the pointer.

 A canvas is a thing you grab, and the cursor is where that gets communicated:
 an open hand over it, a closed one while you are pulling it about, a pointing
 finger the moment a button goes down on something. SwiftUI has no vocabulary
 for this, so the cursor is set on an AppKit view underneath and the gesture
 above tells it which one.

 `cursorUpdate` rather than `resetCursorRects`: rects are recalculated by the
 window at moments of its own choosing, which is fine for a static cursor and
 useless for one that changes mid-drag.
 */
private struct CursorArea: NSViewRepresentable {
    let cursor: NSCursor

    final class Tracking: NSView {
        var cursor: NSCursor = .arrow {
            didSet {
                guard cursor != oldValue else { return }
                // The pointer is already inside; nothing will ask again until it
                // moves, so it is set now as well as declared for later.
                cursor.set()
                window?.invalidateCursorRects(for: self)
            }
        }
        override func resetCursorRects() { addCursorRect(bounds, cursor: cursor) }
        override func cursorUpdate(with event: NSEvent) { cursor.set() }
        override var acceptsFirstResponder: Bool { false }
        // Transparent to everything else: this view exists to answer one
        // question and must not take a click away from the gesture above it.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    func makeNSView(context: Context) -> Tracking {
        let v = Tracking()
        v.cursor = cursor
        return v
    }

    func updateNSView(_ view: Tracking, context: Context) { view.cursor = cursor }
}

/**
 An infinite canvas, currently with nothing on it.

 Deliberately empty for now: pan, zoom, a grid you can turn on, and the
 arithmetic that makes those three agree. What goes *on* it is a later question,
 and building the surface first means that question can be answered without also
 relitigating how zooming works.

 One transform, applied once. Everything drawn here — the grid, and whatever
 comes later — reads `zoom` and `pan` rather than keeping a copy, because two
 things that each remember where the viewport is will disagree the first time
 one of them is animated.
 */
private struct CanvasSurface: View {
    @ObservedObject var chrome: DeskChrome
    /// Where the pan was when the current drag began. A drag reports its total
    /// translation, not an increment, so without this every frame re-applies
    /// the whole gesture from the origin and the canvas leaps.
    @State private var panAtStart: CGSize?
    @State private var zoomAtStart: CGFloat?
    @State private var pressing = false
    @State private var dragging = false

    /// Open over the canvas, pointing the instant a button goes down, closed
    /// once that press starts pulling the canvas about.
    private var cursor: NSCursor {
        if dragging { return .closedHand }
        if pressing { return .pointingHand }
        return .openHand
    }

    var body: some View {
        ZStack {
            if chrome.grid { grid }
            // The content layer. Empty, and the transform is here rather than
            // waiting to be added with the first thing drawn on it — so that
            // whatever arrives inherits a viewport that already works.
            Color.clear
                .scaleEffect(chrome.zoom)
                .offset(chrome.pan)
            CursorArea(cursor: cursor)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    pressing = true
                    // A press is not yet a drag. Below this it is somebody
                    // clicking and the pointer says so; past it they are pulling
                    // the canvas and it becomes a fist.
                    if abs(value.translation.width) > 3 || abs(value.translation.height) > 3 {
                        dragging = true
                    }
                    guard dragging else { return }
                    let base = panAtStart ?? chrome.pan
                    if panAtStart == nil { panAtStart = base }
                    chrome.pan = CGSize(width: base.width + value.translation.width,
                                        height: base.height + value.translation.height)
                }
                .onEnded { _ in
                    panAtStart = nil
                    pressing = false
                    dragging = false
                }
        )
        .simultaneousGesture(
            MagnificationGesture()
                .onChanged { value in
                    let base = zoomAtStart ?? chrome.zoom
                    if zoomAtStart == nil { zoomAtStart = base }
                    chrome.zoom(to: base * value)
                }
                .onEnded { _ in zoomAtStart = nil }
        )
    }

    /// Dots rather than lines. A ruled grid behind a diagram competes with it;
    /// dots say where the spacing is and then get out of the way.
    private var grid: some View {
        Canvas { context, size in
            let step = 24 * chrome.zoom
            // Below this the dots merge into a wash and the grid stops being
            // information — better to draw nothing than a grey field.
            guard step > 6 else { return }
            let dot = max(0.7, 1.1 * min(chrome.zoom, 1.6))
            // Anchored to the pan so the grid moves with the content rather
            // than sitting still behind it, which reads as the canvas sliding
            // over a wall.
            let originX = chrome.pan.width.truncatingRemainder(dividingBy: step)
            let originY = chrome.pan.height.truncatingRemainder(dividingBy: step)
            var y = originY - step
            while y < size.height + step {
                var x = originX - step
                while x < size.width + step {
                    context.fill(
                        Path(ellipseIn: CGRect(x: x, y: y, width: dot, height: dot)),
                        with: .color(.primary.opacity(0.22))
                    )
                    x += step
                }
                y += step
            }
        }
        .allowsHitTesting(false)
    }
}

/**
 The zoom readout, its two buttons, and the two switches that belong with it.

 The switches were in a menu behind the percentage and nobody found them, which
 is the whole argument against putting a setting somewhere it has to be
 discovered. They are buttons now, lit when they are on, sitting next to the
 thing they affect.
 */
private struct CanvasControls: View {
    @ObservedObject var chrome: DeskChrome

    var body: some View {
        HStack(spacing: 2) {
            toggle("squareshape.dotted.squareshape", on: chrome.grid, help: "Dotted grid") {
                chrome.grid.toggle()
            }
            toggle("rectangle.on.rectangle.slash", on: !chrome.seeThrough, help: "Hide what is behind") {
                chrome.seeThrough.toggle()
            }
            Divider().frame(height: 14).padding(.horizontal, 3)
            button("minus", help: "Zoom out") { chrome.zoom(to: chrome.zoom / 1.25) }
            // The one thing anybody wants from a zoom readout is to be told it
            // is 100% again, so the number is the button that does it.
            Button {
                withAnimation(.easeOut(duration: 0.18)) {
                    chrome.zoom(to: 1)
                    chrome.pan = .zero
                }
            } label: {
                Text("\(Int((chrome.zoom * 100).rounded()))%")
                    .font(Theme.chrome(11, weight: .medium))
                    .monospacedDigit()
                    .frame(width: 44, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Back to actual size")
            button("plus", help: "Zoom in") { chrome.zoom(to: chrome.zoom * 1.25) }
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 3)
        .background(
            Capsule().fill(.background.opacity(0.65))
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
        )
    }

    private func toggle(_ symbol: String, on: Bool, help: String, _ act: @escaping () -> Void) -> some View {
        Button(action: act) {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 22, height: 18)
                .contentShape(Rectangle())
                .foregroundStyle(on ? Theme.accent : Color.secondary)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(on ? Color.primary.opacity(0.08) : .clear)
                )
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private func button(_ symbol: String, help: String, _ act: @escaping () -> Void) -> some View {
        Button { withAnimation(.easeOut(duration: 0.14)) { act() } } label: {
            Image(systemName: symbol)
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 20, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
