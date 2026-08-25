import SwiftUI

/// From today, forwards.
///
/// An agenda rather than a month grid: the web app's calendar has four range
/// modes and an all-day band because it has a screen to spend, and a panel that
/// opens on a keystroke is answering a narrower question. You scroll forward
/// through the days instead of paging between them — there is nothing to click
/// to see next week, it is just further down.
///
/// What carries over is the part that changes the answer: which feed an event
/// came from, and which types are shown.
@MainActor
final class AgendaModel: ObservableObject {
    @Published var days: [Daemon.AgendaDay] = []
    @Published var types: [String] = []
    @Published var feeds: [Daemon.Feed] = []
    @Published var hidden: Set<String> = []
    @Published var hiddenFeeds: Set<String> = []
    @Published var feedStale = false
    @Published var error: String?
    @Published var busy = false

    /// The collection this agenda is scoped to. Set by the view before its
    /// first load, and never after — the fetch reads it on the main actor and
    /// then goes away with a copy.
    var collection: String?

    /// The day being looked at. Always a date, never an offset, so the view
    /// doesn't quietly drift if the panel is left open past midnight.
    @Published var date: String = AgendaModel.todayISO()

    static func todayISO() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }

    var isToday: Bool { date == AgendaModel.todayISO() }

    private let hiddenKey = "talaria.agenda.hiddenTypes"
    private let hiddenFeedsKey = "talaria.agenda.hiddenFeeds"

    init() {
        hidden = Set(UserDefaults.standard.stringArray(forKey: hiddenKey) ?? [])
        hiddenFeeds = Set(UserDefaults.standard.stringArray(forKey: hiddenFeedsKey) ?? [])
    }

    func toggle(_ type: String) {
        if hidden.contains(type) { hidden.remove(type) } else { hidden.insert(type) }
        UserDefaults.standard.set(Array(hidden), forKey: hiddenKey)
    }

    func toggleFeed(_ id: String) {
        if hiddenFeeds.contains(id) { hiddenFeeds.remove(id) } else { hiddenFeeds.insert(id) }
        UserDefaults.standard.set(Array(hiddenFeeds), forKey: hiddenFeedsKey)
    }

    /// Tick a task off from here. The daemon queues it if Hermes is away, and
    /// reloading shows it struck through either way.
    func complete(_ item: Daemon.AgendaItem) {
        Task.detached(priority: .userInitiated) { [self] in
            do {
                try Daemon.write(["kind": "complete", "blockId": item.id])
            } catch {
                await MainActor.run { self.error = "\(error)" }
            }
            await MainActor.run { self.load() }
        }
    }

    func load() {
        busy = true
        // Read on the main actor, before the detached task: the property lives
        // here and the fetch does not.
        let scope = collection
        Task.detached(priority: .userInitiated) { [self] in
            do {
                let a = try Daemon.agenda(days: 45, collection: scope)
                await MainActor.run {
                    self.days = a.days
                    self.types = a.types
                    self.feeds = a.feeds
                    self.feedStale = a.feedStale
                    self.error = nil
                    self.busy = false
                }
            } catch {
                await MainActor.run { self.error = "\(error)"; self.busy = false }
            }
        }
    }
}

struct AgendaView: View {
    @ObservedObject var model: AgendaModel
    /// Same reason as the board: an agenda left open stops being today's.
    @State private var watch: MirrorWatch?
    /// Where a feed event goes when clicked. A feed event is not a block and
    /// has no address of its own, so it opens the calendar it belongs to —
    /// which is where you would have gone looking for it anyway.
    var collectionURL: String?
    /// Scope: this agenda is one collection's own view rather than the agenda
    /// proper, so it shows that collection's members and no subscribed feeds.
    ///
    /// A property set before the first load, not something assigned from the
    /// outside afterwards. It was an `.onAppear` on the caller's side, which
    /// fires after this view's own — so the first request went out unscoped and
    /// came back with every feed event in the account, which is precisely the
    /// thing it was added to prevent.
    ///
    /// Not optional. This view has exactly one use — a calendar collection —
    /// and an agenda over everything is not something it is ever asked for, so
    /// forgetting the scope should not be sayable rather than merely wrong.
    let collection: String

    var body: some View {
        VStack(spacing: 0) {
            typeBar
            Divider()
            if let error = model.error {
                Text(error).font(Theme.body(11.5)).foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10, pinnedViews: [.sectionHeaders]) {
                        ForEach(visibleDays, id: \.date) { day in
                            Section {
                                VStack(alignment: .leading, spacing: 4) {
                                    ForEach(events(day), id: \.uid) { event in feedRow(event) }
                                    ForEach(sorted(day.items), id: \.id) { item in itemRow(item) }
                                }
                            } header: {
                                header(day.date)
                            }
                        }
                        if visibleDays.isEmpty && !model.busy { empty }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .onAppear {
            model.collection = collection
            model.load()
            let w = MirrorWatch { model.load() }
            w.start()
            watch = w
        }
        .onDisappear {
            watch?.stop()
            watch = nil
        }
    }

    /// Which types show. The pills persist, because a calendar you have to
    /// re-filter every time you open it is one you stop opening.
    private var typeBar: some View {
        HStack(spacing: 6) {
            // Feeds first, each in its own colour, then the other dated types.
            // Events themselves aren't offered: a calendar you can switch the
            // calendar off in is a strange object, and the web app doesn't.
            ForEach(model.feeds) { feed in
                pill(feed.name,
                     on: !model.hiddenFeeds.contains(feed.id),
                     tint: Color(hex: feed.color) ?? Theme.accent) { model.toggleFeed(feed.id) }
            }
            if !model.feeds.isEmpty && !model.types.isEmpty {
                Divider().frame(height: 12)
            }
            ForEach(model.types, id: \.self) { type in
                pill(type, on: !model.hidden.contains(type), tint: Theme.accent) { model.toggle(type) }
            }
            Spacer()
            if model.feedStale {
                Label("feeds may be out of date", systemImage: "exclamationmark.triangle")
                    .font(Theme.chrome(9.5)).foregroundStyle(.orange)
            }
            if model.busy { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    /// Completed things sink, muted — the same treatment the web calendar gives
    /// them, so a finished task doesn't sit at the top of a day still to come.
    private func sorted(_ items: [Daemon.AgendaItem]) -> [Daemon.AgendaItem] {
        items
            .filter { !model.hidden.contains($0.typeName) }
            .filter { item in
                guard let origin = item.feedOrigin else { return true }
                return !model.hiddenFeeds.contains(origin)
            }
            .sorted { a, b in
                // Unfinished first, then by when they begin.
                if a.done != b.done { return !a.done }
                return (a.start ?? "") < (b.start ?? "")
            }
    }

    private func pill(_ label: String, on: Bool, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(Theme.chrome(10.5, weight: on ? .semibold : .regular))
                .foregroundStyle(on ? AnyShapeStyle(Theme.accentInk) : AnyShapeStyle(.secondary))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(tint.opacity(on ? 0.25 : 0.08)))
                .overlay(Capsule().strokeBorder(on ? tint.opacity(0.6) : .clear, lineWidth: 0.75))
        }
        .buttonStyle(.plain)
    }

    /// Only days with something on them. A fortnight of empty headings is a
    /// lot of scrolling to learn nothing.
    private var visibleDays: [Daemon.AgendaDay] {
        model.days.filter { day in
            !events(day).isEmpty || !sorted(day.items).isEmpty
        }
    }

    private func events(_ day: Daemon.AgendaDay) -> [Daemon.FeedEvent] {
        day.events.filter { !model.hiddenFeeds.contains($0.feedId) }
    }

    private func header(_ date: String) -> some View {
        let isToday = date == AgendaModel.todayISO()
        return HStack(spacing: 7) {
            Text(pretty(date))
                .font(Theme.chrome(11, weight: .semibold))
                .foregroundStyle(isToday ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(.primary))
            if isToday {
                Text("today")
                    .font(Theme.chrome(9)).foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Theme.accent))
            }
            Spacer()
        }
        .padding(.vertical, 5)
        // Opaque, because it pins while the day beneath scrolls under it.
        .background(Rectangle().fill(.background))
    }

    private var empty: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 18)).foregroundStyle(Theme.accent.opacity(0.55))
            Text("Nothing scheduled from here on")
                .font(Theme.body(11.5)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 28)
    }

    private func feedRow(_ event: Daemon.FeedEvent) -> some View {
        HStack(alignment: .top, spacing: 8) {
            // The feed's own colour as a bar, which is how the web app says
            // where an event came from.
            RoundedRectangle(cornerRadius: 1.5)
                .fill(Color(hex: event.color) ?? Theme.accent)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 2) {
                Text(event.summary).font(Theme.body(11.5)).lineLimit(2)
                HStack(spacing: 6) {
                    if !event.allDay {
                        Text(times(start: event.start, end: event.end, startsToday: true, endsToday: true))
                            .font(Theme.chrome(9.5)).foregroundStyle(.secondary)
                    }
                    if !event.location.isEmpty {
                        Label(event.location, systemImage: "mappin.and.ellipse")
                            .font(Theme.chrome(9.5)).foregroundStyle(.tertiary).lineLimit(1)
                    }
                    Text(event.feedName).font(Theme.chrome(9.5)).foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5).padding(.horizontal, 7)
        .frame(minHeight: 30)
        .background(RoundedRectangle(cornerRadius: Theme.controlRadius).fill(Color.secondary.opacity(0.07)))
        .contentShape(Rectangle())
        .onTapGesture {
            if let s = collectionURL, let u = URL(string: s) { Opener.open(u) }
        }
    }

    /// The line under an item's title. Split out because the whole row as one
    /// expression was more than the type checker would take.
    private func itemMeta(_ item: Daemon.AgendaItem, source: Daemon.Feed?) -> some View {
        let tint: Color = source.flatMap { Color(hex: $0.color) } ?? Theme.accent
        let when = times(start: item.start, end: item.end,
                         startsToday: item.startsToday, endsToday: item.endsToday)
        return HStack(spacing: 6) {
            Text(source?.name ?? item.typeName)
                .font(Theme.chrome(9.5))
                .foregroundStyle(tint)
            if let end = item.endLabel {
                Text(end.lowercased()).font(Theme.chrome(9.5)).foregroundStyle(.orange)
            }
            if !when.isEmpty {
                Text(when).font(Theme.chrome(9.5)).foregroundStyle(.secondary)
            }
        }
    }

    /// The feed a converted block came from, if that feed is still around.
    private func feed(of item: Daemon.AgendaItem) -> Daemon.Feed? {
        guard let origin = item.feedOrigin else { return nil }
        return model.feeds.first { $0.id == origin }
    }

    private func itemRow(_ item: Daemon.AgendaItem) -> some View {
        let source = feed(of: item)
        return HStack(alignment: .top, spacing: 8) {
            if let source {
                // Converted from a calendar: it still says which one at a
                // glance, the same bar the feed's own events wear.
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color(hex: source.color) ?? Theme.accent)
                    .frame(width: 3)
            }
            if item.canComplete {
                Button { model.complete(item) } label: {
                    Image(systemName: item.done ? "checkmark.square.fill" : "square")
                        .font(.system(size: 12))
                        .foregroundStyle(item.done ? Theme.accent : Color.secondary)
                }
                .buttonStyle(.borderless)
                .disabled(item.done)
                .help(item.done ? "Already done" : "Mark complete")
            } else {
                // Nothing to tick: this is a note or a person that happens to
                // carry a date, so it gets a mark of what it is instead.
                Image(systemName: Theme.symbol(forTool: item.typeName))
                    .font(.system(size: 11)).foregroundStyle(.tertiary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .font(Theme.body(11.5))
                    .strikethrough(item.done)
                    .foregroundStyle(item.done ? .secondary : .primary)
                    .lineLimit(2)
                itemMeta(item, source: source)
            }
            Spacer(minLength: 0)
        }
        .opacity(item.done ? 0.55 : 1)
        .padding(.vertical, 5).padding(.horizontal, 7)
        .contentShape(Rectangle())
        .onTapGesture { if let u = URL(string: item.url) { Opener.open(u) } }
    }

    private func pretty(_ date: String) -> String {
        let inF = DateFormatter(); inF.dateFormat = "yyyy-MM-dd"
        guard let d = inF.date(from: date) else { return date }
        let out = DateFormatter(); out.dateFormat = "EEEE, d MMMM"
        return out.string(from: d)
    }

    /// Both ends when both are known, and which end it is when only one falls
    /// on this day — "from 9:00" reads as a thing still running, which is what
    /// a span reaching past today actually means.
    private func times(start: String?, end: String?, startsToday: Bool, endsToday: Bool) -> String {
        let s = start.map(time) ?? ""
        let e = end.map(time) ?? ""
        if startsToday && endsToday && !s.isEmpty && !e.isEmpty { return "\(s) – \(e)" }
        if startsToday && !s.isEmpty { return endsToday ? s : "from \(s)" }
        if endsToday && !e.isEmpty { return "until \(e)" }
        return s.isEmpty ? e : s
    }

    /// Twelve-hour, always.
    ///
    /// `timeStyle: .short` follows whatever the system's region is set to, so a
    /// 24-hour setting quietly turned every time in the agenda into one. A fixed
    /// format with a POSIX locale is the way to mean 12-hour and get it.
    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "h:mm a"
        return f
    }()

    private func time(_ iso: String) -> String {
        guard iso.contains("T") else { return "" }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        let d = f.date(from: String(iso.prefix(16))) ?? ISO8601DateFormatter().date(from: iso)
        guard let d else { return "" }
        // "8:00 AM" rather than "8:00 am": the rest of the row is chrome, and
        // this is the part someone reads at a glance.
        return Self.clock.string(from: d)
    }
}
