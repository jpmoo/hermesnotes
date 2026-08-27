import AppKit
import SwiftUI

/**
 A new block, in whatever shape the library says a block can be.

 The whole point of this panel is that it contains no idea of what a Task is.
 Types are rows the user owns — renameable, reshapeable, addable — so a composer
 with a Task-shaped form written into it is wrong the first time somebody adds a
 field, and wrong silently: the field simply never appears. So the form is drawn
 from what `/types` declares, field by field, by `kind`.

 Writes through Hermes' own API rather than the interchange binding. The format
 has no `create` verb yet (see LIMITS.md), and inventing one here to avoid using
 the richer channel would be the tail wagging the dog. It still goes through the
 queue, so a block composed offline exists locally and is sent on reconnect.
 */

@MainActor
final class ComposeModel: ObservableObject {
    @Published var types: [Daemon.BlockType] = []
    @Published var typeId: String = ""
    @Published var busy = false
    @Published var error: String?
    @Published var loaded = false

    /// Everything a field can hold, kept by kind rather than in one bag —
    /// SwiftUI wants a `Binding` to something concrete, and three small
    /// dictionaries bind far more simply than one of boxed enums.
    @Published var strings: [String: String] = [:]      // text, richtext, enum, number
    @Published var starts: [String: Date?] = [:]        // datespan, near end
    @Published var ends: [String: Date?] = [:]          // datespan, far end
    @Published var refs: [String: [String]] = [:]       // reference
    /// Prose for a type whose body lives in the reserved `content` slot.
    @Published var body = ""

    /// Candidates for reference fields, by the type they point at. Fetched once
    /// per type rather than per keystroke: a library has a few hundred blocks
    /// and this is a local SQLite read.
    @Published var candidates: [String: [Daemon.Card]] = [:]

    var type: Daemon.BlockType? { types.first { $0.id == typeId } }

    /// Which type a new block defaults to, remembered between openings. Most
    /// people make far more of one thing than of anything else.
    private static let lastKey = "talaria.composeType"

    func load() {
        error = nil
        Task.detached(priority: .userInitiated) { [weak self] in
            let found = try? Daemon.types()
            await MainActor.run {
                guard let self else { return }
                self.loaded = true
                guard let found, !found.isEmpty else {
                    self.error = "No types yet — has a sync finished?"
                    return
                }
                self.types = found
                if self.typeId.isEmpty {
                    let remembered = UserDefaults.standard.string(forKey: Self.lastKey)
                    self.typeId = found.first { $0.id == remembered }?.id ?? found[0].id
                }
                self.loadCandidates()
            }
        }
    }

    /// Reset the form when the type changes — the fields are different, and
    /// carrying a value across into a field that happens to share a key would
    /// be putting words in somebody's mouth.
    func typeChanged() {
        strings = [:]
        starts = [:]
        ends = [:]
        refs = [:]
        body = ""
        error = nil
        UserDefaults.standard.set(typeId, forKey: Self.lastKey)
        loadCandidates()
    }

    private func loadCandidates() {
        let wanted = (type?.fields ?? [])
            .filter { $0.kind == "reference" }
            .compactMap(\.targetType)
        guard !wanted.isEmpty else { return }
        Task.detached(priority: .userInitiated) { [weak self] in
            var found: [String: [Daemon.Card]] = [:]
            for t in wanted {
                found[t] = (try? Daemon.blocks(ofType: t)) ?? []
            }
            await MainActor.run { self?.candidates.merge(found) { _, new in new } }
        }
    }

    /// The title, for the confirmation. Read through the type's own title key
    /// where it declares one, and by the conventional key otherwise.
    private var titleValue: String {
        let key = type?.titleKey ?? "title"
        let t = (strings[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
        return body.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Untitled"
    }

    /// Whether there is anything worth saving. A block with no title and no body
    /// is not a draft, it is an empty row.
    var hasSomething: Bool {
        !titleValue.isEmpty && titleValue != "Untitled"
            || !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func save(onDone: @escaping (String) -> Void) {
        guard let type else { return }
        busy = true
        error = nil

        var properties: [String: Any] = [:]
        for field in type.fields {
            switch field.kind {
            case "text", "richtext", "enum":
                let v = (strings[field.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !v.isEmpty { properties[field.key] = v }
            case "number":
                // Written as a number, never as the string somebody typed: the
                // property is compared and summed on the far side, and "30" and
                // 30 are not the same value there.
                let raw = (strings[field.key] ?? "").trimmingCharacters(in: .whitespaces)
                if !raw.isEmpty, let n = Double(raw) { properties[field.key] = n }
            case "datespan":
                var span: [String: String] = [:]
                if let s = starts[field.key] ?? nil { span["start"] = Self.day.string(from: s) }
                if let e = ends[field.key] ?? nil { span["end"] = Self.day.string(from: e) }
                if !span.isEmpty { properties[field.key] = span }
            case "reference":
                let picked = refs[field.key] ?? []
                // Always a list, even for a single-valued field: that is the
                // shape every reference in this library is stored in.
                if !picked.isEmpty { properties[field.key] = picked }
            default:
                // recurrence and attachment. Deliberately not written rather
                // than written badly — a malformed recurrence is a block that
                // spawns wrong occurrences forever, which is much worse than a
                // field you have to go and fill in on the web.
                break
            }
        }

        let content = type.bodySlot == "content" ? body : nil
        // A body with nowhere reserved to go still belongs somewhere. If the
        // type declares a richtext field and nothing has been typed into it,
        // that is where prose goes.
        if type.bodySlot != "content", !body.trimmingCharacters(in: .whitespaces).isEmpty,
           let prose = type.fields.first(where: { $0.kind == "richtext" })?.key,
           properties[prose] == nil {
            properties[prose] = body.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let typeId = type.id
        let title = titleValue
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                try Daemon.create(blockTypeId: typeId, content: content, properties: properties)
                await MainActor.run {
                    self?.busy = false
                    onDone(title)
                }
            } catch {
                await MainActor.run {
                    self?.busy = false
                    self?.error = "\(error)"
                }
            }
        }
    }

    /// `YYYY-MM-DD` in the local zone — a due date is a day in the reader's
    /// calendar, not an instant in UTC.
    static let day: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f
    }()
}

struct ComposeView: View {
    @ObservedObject var model: ComposeModel
    /// Called with the new block's title once it has been handed to the daemon.
    var onSaved: (String) -> Void = { _ in }
    @FocusState private var firstField: Bool

    var body: some View {
        VStack(spacing: 0) {
            picker
            Divider().opacity(0.35)
            if let error = model.error {
                message(error)
            } else if !model.loaded {
                message("…")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(model.type?.fields ?? []) { field in
                            row(field)
                        }
                        if model.type?.bodySlot == "content" {
                            labelled("Body") {
                                TextEditor(text: $model.body)
                                    .font(.system(size: 12))
                                    .scrollContentBackground(.hidden)
                                    .frame(height: 140)
                                    .padding(4)
                                    .background(fieldBackground)
                            }
                        }
                        if let skipped = unsupported, !skipped.isEmpty {
                            // Said out loud. A field that silently never appears
                            // reads as the composer being broken; a field that
                            // says it is not here reads as a boundary.
                            Text("\(skipped.joined(separator: ", ")) — set in Hermes Notes after saving.")
                                .font(.system(size: 10))
                                .foregroundStyle(.tertiary)
                                .padding(.top, 2)
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                }
            }
            Divider().opacity(0.35)
            footer
        }
        .frame(width: 480, height: 560)
        .background(VisualEffect(radius: 0))
    }

    private var unsupported: [String]? {
        model.type?.fields
            .filter { $0.kind == "recurrence" || $0.kind == "attachment" }
            .map(\.display)
    }

    private var picker: some View {
        HStack(spacing: 8) {
            Text("New")
                .font(Theme.chrome(12, weight: .semibold))
            Picker("", selection: $model.typeId) {
                ForEach(model.types) { t in
                    Label(t.display, systemImage: Theme.symbol(forTool: t.display)).tag(t.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 200)
            .onChange(of: model.typeId) { _, _ in model.typeChanged() }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private func row(_ field: Daemon.TypeField) -> some View {
        switch field.kind {
        case "text":
            labelled(field.display) {
                TextField("", text: binding(field.key))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
            }
        case "richtext":
            labelled(field.display) {
                TextEditor(text: binding(field.key))
                    .font(.system(size: 12))
                    .scrollContentBackground(.hidden)
                    .frame(height: 84)
                    .padding(4)
                    .background(fieldBackground)
            }
        case "number":
            labelled(field.display) {
                TextField("", text: binding(field.key))
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
                    .frame(width: 90)
            }
        case "enum":
            labelled(field.display) {
                Picker("", selection: binding(field.key)) {
                    Text("—").tag("")
                    ForEach(field.options ?? [], id: \.self) { Text($0).tag($0) }
                }
                .labelsHidden()
                .frame(maxWidth: 200)
            }
        case "datespan":
            labelled(field.display) {
                VStack(alignment: .leading, spacing: 5) {
                    DateLeg(label: field.startLabel ?? "Start", date: dateBinding(field.key, start: true))
                    DateLeg(label: field.endLabel ?? "End", date: dateBinding(field.key, start: false))
                }
            }
        case "reference":
            labelled(field.display) {
                ReferencePicker(
                    candidates: model.candidates[field.targetType ?? ""] ?? [],
                    many: field.isMany,
                    picked: Binding(
                        get: { model.refs[field.key] ?? [] },
                        set: { model.refs[field.key] = $0 }
                    )
                )
            }
        default:
            EmptyView()
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if let t = model.type?.display {
                Text("Saved to Hermes Notes as a \(t)")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 6)
            if model.busy { ProgressView().controlSize(.small).scaleEffect(0.7) }
            Button("Save") { model.save(onDone: onSaved) }
                .keyboardShortcut(.defaultAction)
                .disabled(model.busy || !model.hasSomething)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
    }

    // MARK: Pieces

    private var fieldBackground: some View {
        RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05))
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { model.strings[key] ?? "" }, set: { model.strings[key] = $0 })
    }

    private func dateBinding(_ key: String, start: Bool) -> Binding<Date?> {
        Binding(
            get: { (start ? model.starts[key] : model.ends[key]) ?? nil },
            set: { if start { model.starts[key] = $0 } else { model.ends[key] = $0 } }
        )
    }

    private func labelled<C: View>(_ label: String, @ViewBuilder content: () -> C) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 96, alignment: .trailing)
                .padding(.top, 4)
            content()
            Spacer(minLength: 0)
        }
    }

    private func message(_ text: String) -> some View {
        VStack {
            Spacer()
            Text(text).font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }
}

/// One end of a datespan, which is optional in a way `DatePicker` is not.
private struct DateLeg: View {
    let label: String
    @Binding var date: Date?

    var body: some View {
        HStack(spacing: 6) {
            Toggle("", isOn: Binding(
                get: { date != nil },
                set: { date = $0 ? (date ?? Calendar.current.startOfDay(for: Date())) : nil }
            ))
            .toggleStyle(.checkbox)
            .labelsHidden()

            Text(label).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 62, alignment: .leading)

            if date != nil {
                DatePicker("", selection: Binding(
                    get: { date ?? Date() },
                    set: { date = $0 }
                ), displayedComponents: .date)
                .labelsHidden()
                .datePickerStyle(.compact)
            } else {
                Text("not set").font(.system(size: 11)).foregroundStyle(.tertiary)
            }
        }
    }
}

/// Picking blocks for a reference field, from what the library actually has.
private struct ReferencePicker: View {
    let candidates: [Daemon.Card]
    let many: Bool
    @Binding var picked: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Menu {
                if candidates.isEmpty {
                    Text("Nothing of that type yet")
                } else {
                    ForEach(candidates) { c in
                        Button {
                            toggle(c.id)
                        } label: {
                            // A tick rather than a separate selected list: the
                            // menu is where you look to see what is on.
                            Label(c.title, systemImage: picked.contains(c.id) ? "checkmark" : "")
                        }
                    }
                }
            } label: {
                Text(summary).font(.system(size: 11))
            }
            .menuStyle(.borderlessButton)
            .frame(maxWidth: 240, alignment: .leading)
        }
    }

    private var summary: String {
        if picked.isEmpty { return "—" }
        let names = picked.compactMap { id in candidates.first { $0.id == id }?.title }
        return names.isEmpty ? "\(picked.count) selected" : names.joined(separator: ", ")
    }

    private func toggle(_ id: String) {
        if picked.contains(id) {
            picked.removeAll { $0 == id }
        } else if many {
            picked.append(id)
        } else {
            picked = [id]
        }
    }
}
