import SwiftUI

/// What's coming up.
///
/// An agenda rather than a month grid. The web app's calendar carries four
/// range modes, an all-day band, multi-day lanes and drag — most of which exists
/// because it has a screen to spend. In a panel the useful question is "what is
/// coming", and the two things that change the answer are kept: which feed an
/// event came from, and which types are shown.
@MainActor
final class AgendaModel: ObservableObject {
    @Published var days: [Daemon.AgendaDay] = []
    @Published var types: [String] = []
    @Published var hidden: Set<String> = []
    @Published var feedStale = false
    @Published var error: String?
    @Published var busy = false

    private let hiddenKey = "talaria.agenda.hiddenTypes"

    init() {
        hidden = Set(UserDefaults.standard.stringArray(forKey: hiddenKey) ?? [])
    }

    func toggle(_ type: String) {
        if hidden.contains(type) { hidden.remove(type) } else { hidden.insert(type) }
        UserDefaults.standard.set(Array(hidden), forKey: hiddenKey)
    }

    func load() {
        busy = true
        Task.detached(priority: .userInitiated) { [self] in
            do {
                let a = try Daemon.agenda(days: 14)
                await MainActor.run {
                    self.days = a.days
                    self.types = a.types
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
                    LazyVStack(alignment: .leading, spacing: 12, pinnedViews: [.sectionHeaders]) {
                        ForEach(visibleDays, id: \.date) { day in
                            Section {
                                ForEach(day.events, id: \.uid) { event in feedRow(event) }
                                ForEach(sorted(day.items), id: \.id) { item in itemRow(item) }
                            } header: {
                                dayHeader(day.date)
                            }
                        }
                        if visibleDays.isEmpty {
                            Text("Nothing scheduled in the next fortnight")
                                .font(Theme.body(11.5)).foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity).padding(.vertical, 24)
                        }
                    }
                    .padding(12)
                }
            }
        }
        .onAppear { model.load() }
    }

    /// Which types show. The pills persist, because a calendar you have to
    /// re-filter every time you open it is one you stop opening.
    private var typeBar: some View {
        HStack(spacing: 6) {
            ForEach(model.types, id: \.self) { type in
                let on = !model.hidden.contains(type)
                Button { model.toggle(type) } label: {
                    Text(type)
                        .font(Theme.chrome(10.5, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? Theme.accentInk : Color.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(on ? Theme.accent.opacity(0.20) : Color.secondary.opacity(0.10)))
                        .overlay(Capsule().strokeBorder(on ? Theme.accent.opacity(0.45) : .clear, lineWidth: 0.75))
                }
                .buttonStyle(.plain)
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

    private var visibleDays: [Daemon.AgendaDay] {
        model.days.filter { day in
            !day.events.isEmpty || day.items.contains { !model.hidden.contains($0.typeName) }
        }
    }

    /// Completed things sink, muted — the same treatment the web calendar gives
    /// them, so a finished task doesn't sit at the top of a day still to come.
    private func sorted(_ items: [Daemon.AgendaItem]) -> [Daemon.AgendaItem] {
        items.filter { !model.hidden.contains($0.typeName) }
            .sorted { a, b in a.done == b.done ? (a.at ?? "") < (b.at ?? "") : (!a.done && b.done) }
    }

    private func dayHeader(_ date: String) -> some View {
        HStack(spacing: 7) {
            Text(pretty(date)).font(Theme.chrome(11, weight: .semibold))
            if date == todayISO() {
                Text("today")
                    .font(Theme.chrome(9)).foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Theme.accent))
            }
            Spacer()
        }
        .padding(.vertical, 4)
        .background(.background.opacity(0.96))
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
            Image(systemName: item.done ? "checkmark.square.fill" : Theme.symbol(forCollection: nil))
                .font(.system(size: 11))
                .foregroundStyle(item.done ? Theme.accent : Color.secondary)
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

    private func todayISO() -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f.string(from: Date())
    }

    private func pretty(_ date: String) -> String {
        let inF = DateFormatter(); inF.dateFormat = "yyyy-MM-dd"
        guard let d = inF.date(from: date) else { return date }
        let out = DateFormatter(); out.dateFormat = "EEEE d MMMM"
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
