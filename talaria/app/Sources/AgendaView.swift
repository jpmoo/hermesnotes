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
        Task.detached(priority: .userInitiated) { [self] in
            do {
                let a = try Daemon.agenda(days: 45)
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
        .onAppear { model.load() }
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
        items.filter { !model.hidden.contains($0.typeName) }
            .sorted { a, b in a.done == b.done ? (a.at ?? "") < (b.at ?? "") : (!a.done && b.done) }
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
                    if !event.allDay { Text(time(event.start)).font(Theme.chrome(9.5)).foregroundStyle(.secondary) }
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
    }

    private func itemRow(_ item: Daemon.AgendaItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
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
                HStack(spacing: 6) {
                    Text(item.typeName).font(Theme.chrome(9.5)).foregroundStyle(Theme.accent)
                    if item.isEnd { Text("due").font(Theme.chrome(9.5)).foregroundStyle(.orange) }
                    if let at = item.at { Text(time(at)).font(Theme.chrome(9.5)).foregroundStyle(.secondary) }
                }
            }
            Spacer(minLength: 0)
        }
        .opacity(item.done ? 0.55 : 1)
        .padding(.vertical, 5).padding(.horizontal, 7)
        .contentShape(Rectangle())
        .onTapGesture { if let u = URL(string: item.url) { NSWorkspace.shared.open(u) } }
    }

    private func pretty(_ date: String) -> String {
        let inF = DateFormatter(); inF.dateFormat = "yyyy-MM-dd"
        guard let d = inF.date(from: date) else { return date }
        let out = DateFormatter(); out.dateFormat = "EEEE, d MMMM"
        return out.string(from: d)
    }

    private func time(_ iso: String) -> String {
        guard iso.contains("T") else { return "" }
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        let alt = ISO8601DateFormatter()
        let d = f.date(from: String(iso.prefix(16))) ?? alt.date(from: iso)
        guard let d else { return "" }
        let out = DateFormatter(); out.timeStyle = .short; out.dateStyle = .none
        return out.string(from: d)
    }
}
