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

/**
 How wide a control is, and why it is a number rather than a spring.

 The panel is a fixed 480 wide, so this is 480 less the horizontal padding, the
 label column and the gap between them. Stated once and used by everything,
 because `.borderedButton` honours a fixed width on its label and ignores
 `maxWidth: .infinity` entirely — greedy layout made the menus collapse to their
 own content while the text fields filled the row, which is the mismatch this
 exists to remove.

 `menuInset` is the chrome a bordered menu draws around its label: padding plus
 the disclosure arrow. Measured, not derived — nothing will tell you.
 */
enum Field {
    /**
     The narrowest the form can be drawn and still hold its fields.

     A real constraint rather than a preference: the fields below are laid out at
     a fixed width so that every row lines up, and that width is worked out from
     this number. Anything narrower does not compress the form, it clips it.

     It exists because the number was written down twice and the two copies
     disagreed. The fields were sized from 480 and the window declared it could
     go to 420, so the window went to 420 — a hosting controller sizes to the
     minimum it is given — and the fields, still 338 wide in a 278-wide space,
     ran off the right-hand edge. One constant, both users.
     */
    static let formWidth: CGFloat = 480
    static let width: CGFloat = formWidth - 36 - 96 - 10
    static let menuInset: CGFloat = 47

    /// How a list of choices is ordered. `localizedStandardCompare` is the
    /// Finder's comparison: case-insensitive, and "Item 2" before "Item 10"
    /// rather than after it.
    static func ordered(_ items: [String]) -> [String] {
        items.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}

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
    @Published var candidates: [String: [Daemon.Reference]] = [:]
    /// Why a reference menu is empty, when it is empty for a reason.
    @Published var candidateError: String?

    /// Text that was selected somewhere else when this was opened. Held rather
    /// than applied once, because the type can change afterwards and the field
    /// it belongs in changes with it.
    private var seed: String?

    var type: Daemon.BlockType? { types.first { $0.id == typeId } }

    /**
     Which declared field is the body, when the body lives outside the bag.

     `fields` says what a type *has*; `profiles.note.body` says where it *lives*.
     Read together, a type that declares a richtext field and also says its body
     is `content` is describing one thing in two places — the field is the body,
     and the profile is redirecting its storage out of the property bag.

     Read apart, which is what this did, you get two editors. The Text type
     declares `description` labelled "Body" and puts its prose in `content`, so
     the panel drew that field *and* a synthesised body beneath it, both called
     Body. Hermes writes neither of the two: zero of nineteen Text blocks in
     this library have a `description` at all.

     Only the first richtext field is claimed. A type with two of them is
     describing two different things, and only one of them can be the slot the
     profile named.
     */
    var bodyField: Daemon.TypeField? {
        guard isProse else { return nil }
        return type?.fields.first { $0.kind == "richtext" }
    }

    /**
     Whether this type is prose and nothing else.

     A type whose note profile puts its body in `content` is one Hermes stores
     as text — and on create it keeps the content and **discards the property
     bag entirely**. `server.ts` has said so since the capture Service was
     written; this panel had not read it, and offered a Title field that was
     silently thrown away on save. What comes back instead is the first line of
     the body, which is Hermes deciding the title rather than storing one.

     So for these types the panel offers the body and says where the title comes
     from. Offering fields that do nothing is worse than offering none: a title
     you typed and cannot find afterwards reads as data loss, because it is.
     */
    var isProse: Bool { type?.bodySlot == "content" }

    /// Which type a new block defaults to, remembered between openings. Most
    /// people make far more of one thing than of anything else.
    private static let lastKey = "talaria.composeType"

    /**
     Open the composer.

     A selection empties whatever was here first. Highlighting something and
     pressing the hotkey says "make a new thing about this", and seeding the
     title while yesterday's due date and project sat underneath would produce a
     block half about something else.

     Without one, a half-typed draft survives. That is the case where the panel
     was closed rather than finished — a stray Escape, a click on the close
     button — and losing the sentence somebody was partway through would be a
     worse failure than showing it to them again.
     */
    func load(seed: String? = nil) {
        if seed != nil { reset() }
        self.seed = seed
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
                self.applySeed()
            }
        }
    }

    /**
     Put a selection into the field it belongs in.

     The first declared field, because that is the one a type leads with and the
     one somebody means by "make a note of this" — title on most things, and
     whatever a type happens to lead with otherwise.

     Split rather than dumped, when that field holds one line. A multi-line
     selection in a title is a title with newlines in it; the first line is the
     name of the thing and the rest is what it says, which is the same rule the
     capture Service has always used. Nothing is dropped: if there is nowhere
     for prose to go, the whole selection stays in the first field rather than
     losing the tail.
     */
    private func applySeed() {
        guard let seed, let type, let first = type.fields.first else { return }
        // Word ends its lines with a carriage return, and splitting on "\n"
        // alone found none — so a two-line selection arrived as one line, the
        // whole thing went into the title, and the split looked broken in
        // exactly the application it had just been made to work in. Normalise
        // first; "\r\n" before "\r" or every Windows-authored paragraph
        // becomes two.
        let flat = seed.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = flat.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let head = lines.first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? flat
        let tail = lines.drop(while: { $0.trimmingCharacters(in: .whitespaces).isEmpty })
            .dropFirst().joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)

        // A field that holds prose takes the lot; a one-line field takes the
        // first line and hands the rest on.
        // A prose type has one place for everything, so nothing is split off.
        if isProse {
            body = flat
            return
        }
        let oneLine = first.kind == "text"
        guard oneLine, !tail.isEmpty else {
            strings[first.key] = flat
            return
        }
        strings[first.key] = head
        if type.bodySlot == "content" {
            body = tail
        } else if let prose = type.fields.first(where: { $0.kind == "richtext" })?.key {
            strings[prose] = tail
        } else {
            // Nowhere to put it. Keeping it in the first field is ugly and is
            // still better than a composer that silently ate half a selection.
            strings[first.key] = flat
        }
    }

    /**
     Empty the form.

     Its own function because the clearing used to happen by accident. The type
     picker's `onChange` calls `typeChanged`, and on the very first open the
     type goes from "" to something, so it fired and the form came up blank —
     which looked like the panel resetting itself. On every open after that the
     type is unchanged, nothing fires, and the last block's title is still
     sitting there waiting to be saved again under a new id.
     */
    func reset() {
        strings = [:]
        starts = [:]
        ends = [:]
        refs = [:]
        body = ""
        error = nil
    }

    /// Reset when the type changes — the fields are different, and carrying a
    /// value across into a field that happens to share a key would be putting
    /// words in somebody's mouth.
    func typeChanged() {
        reset()
        UserDefaults.standard.set(typeId, forKey: Self.lastKey)
        loadCandidates()
        applySeed()
    }

    private func loadCandidates() {
        let wanted = (type?.fields ?? [])
            .filter { $0.kind == "reference" }
            .compactMap(\.targetType)
        guard !wanted.isEmpty else { return }
        Task.detached(priority: .userInitiated) { [weak self] in
            var found: [String: [Daemon.Reference]] = [:]
            var failure: String?
            for t in wanted {
                do {
                    found[t] = try Daemon.blocks(ofType: t)
                } catch {
                    // Kept, not swallowed. An empty dropdown that cannot say why
                    // is what made this bug invisible in the first place.
                    found[t] = []
                    failure = "\(error)"
                }
            }
            await MainActor.run {
                self?.candidates.merge(found) { _, new in new }
                self?.candidateError = failure
            }
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

    /// Saves, and says which block it made.
    ///
    /// The id travels because a canvas node that made a block has to be able to
    /// name it afterwards. Nil when the write was queued rather than applied —
    /// offline, the block does not exist yet and there is nothing honest to
    /// point at.
    func save(onDone: @escaping (String, String?) -> Void) {
        guard let type else { return }
        busy = true
        error = nil

        var properties: [String: Any] = [:]
        let bodyKey = bodyField?.key
        // Nothing to send: Hermes discards the bag for these and titles the
        // block from its first line.
        for field in type.fields where !isProse {
            // Claimed as the body: its text goes to `content`, and writing it
            // as a property as well would store the same prose twice under two
            // names.
            if field.key == bodyKey { continue }
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
            // Only reached when nothing reserved a slot for prose.
            properties[prose] = body.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        let typeId = type.id
        let title = titleValue
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let made = try Daemon.create(blockTypeId: typeId, content: content, properties: properties)
                await MainActor.run {
                    self?.busy = false
                    // The block exists now, so the form has done its job. Left
                    // full, the next thing you compose starts as a copy of the
                    // last one — which is how the same title gets saved twice
                    // under two ids.
                    self?.reset()
                    self?.seed = nil
                    onDone(title, made)
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
    /// Whether this is a window of its own, or a quadrant of the desk. A window
    /// needs an opaque surface to hold a form against a desktop; a quadrant is
    /// already inside one, and painting a second sheet over the frost is what
    /// stopped the desk being frosted where the form was.
    var standalone = true
    /// Called with the new block's title once it has been handed to the daemon.
    var onSaved: (String, String?) -> Void = { _, _ in }
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
                        if model.isProse {
                            bodyEditor(model.bodyField?.display ?? "Body")
                            Text("Hermes titles a \(model.type?.display ?? "text") block from its first line — the other fields are not stored on one, so they are not offered here.")
                                .font(.system(size: 10))
                                .foregroundStyle(.tertiary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.leading, 106)
                        } else {
                            ForEach(model.type?.fields ?? []) { field in
                                row(field)
                            }
                        }
                        if let skipped = unsupported, !skipped.isEmpty, !model.isProse {
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
        // Its own size as a panel, and whatever it is given as a quadrant. The
        // fields inside keep their measured widths — the alignment work that
        // made every row line up is not something a wider container should
        // undo — so a bigger frame gives the form more room around it and more
        // of its own scroll view, which is what a form in a quarter of a screen
        // needs.
        // In a window, the form's own width is the floor — there is nothing
        // below it but clipping. In a desk quadrant it is not, because the pane
        // has a scroll view and a floor there would push the pane beside it off
        // the screen, which is the failure the quadrant layout already had once.
        .frame(minWidth: standalone ? Field.formWidth : 420,
               idealWidth: Field.formWidth, maxWidth: .infinity,
               minHeight: 320, idealHeight: 560, maxHeight: .infinity)
        .background(standalone ? AnyView(VisualEffect(radius: 0)) : AnyView(Color.clear))
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
                ClearableField(text: binding(field.key), plain: !standalone)
            }
        case "richtext":
            // The body is bound to `content` rather than to a property, and is
            // given the room prose needs; any other richtext field is an
            // ordinary one.
            if field.key == model.bodyField?.key {
                bodyEditor(field.display)
            } else {
                labelled(field.display) {
                    TextEditor(text: binding(field.key))
                        .font(.system(size: 12))
                        .scrollContentBackground(.hidden)
                        .frame(width: Field.width - 8, height: 84)
                        .padding(4)
                        .background(fieldBackground)
                }
            }
        case "number":
            labelled(field.display) {
                ClearableField(text: binding(field.key), width: 90, plain: !standalone)
            }
        case "enum":
            labelled(field.display) {
                FieldMenu(summary: (model.strings[field.key] ?? "").isEmpty ? "—" : model.strings[field.key]!) {
                    Button("—") { model.strings[field.key] = "" }
                    Divider()
                    ForEach(Field.ordered(field.options ?? []), id: \.self) { option in
                        Button {
                            model.strings[field.key] = option
                        } label: {
                            Label(option, systemImage: model.strings[field.key] == option ? "checkmark" : "")
                        }
                    }
                }
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
                    problem: model.candidateError,
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
        // No caption beside the button.
        //
        // It read "Saved to Hermes Notes as a Task" and sat inches from a button
        // reading "Save", in the past tense, before anything had been saved —
        // so the honest reading of the two together was that the thing was
        // already done and the button was for something else. The type picker at
        // the top already says what is being made, and where it goes is the
        // whole premise of the app.
        HStack(spacing: 8) {
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

    private func bodyEditor(_ label: String) -> some View {
        labelled(label) {
            TextEditor(text: $model.body)
                .font(.system(size: 12))
                .scrollContentBackground(.hidden)
                .frame(width: Field.width - 8, height: 150)
                .padding(4)
                .background(fieldBackground)
        }
    }

    private var fieldBackground: some View {
        RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05))
    }

    /// What `.roundedBorder` draws, approximately, for the standalone window
    /// where an opaque field is the right thing.
    private var bezel: some View {
        RoundedRectangle(cornerRadius: 6)
            .fill(Color(nsColor: .textBackgroundColor))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.primary.opacity(0.15), lineWidth: 0.5))
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
/**
 The one control both menus wear.

 They used to be two: an enum was a `Picker` and a reference was a `Menu`,
 because a reference can be multi-valued and `Picker` does not do that. Two
 different SwiftUI controls meant two different sets of chrome — and a `Picker`
 reserves space for its label even with `.labelsHidden()`, so its box started a
 label's width to the right of every text field on the panel. Rows that should
 have shared a left edge did not.

 One control, fixed width, drawn here rather than inherited, so single and
 multi-valued fields look the same and line up with everything else.
 */
/**
 A one-line field with a way to empty it.

 For the case the seeding created: the composer fills the first field from
 whatever was selected, and sometimes that is not what somebody wanted — a stray
 click before the hotkey, a selection left over from reading something else — so
 the first thing they have to do is select the text and delete it before they can
 type.

 Inside the field's trailing edge rather than beside it. Outside would make this
 row wider than every other row in the form, which is the alignment that was
 deliberately made uniform; a clear button is not worth spending that on. It is
 also where macOS puts one.

 Shown only when there is something to clear, so an empty form is not a column of
 crosses.
 */
private struct ClearableField: View {
    @Binding var text: String
    var width: CGFloat = Field.width
    /// Draw the field's own surface instead of AppKit's bezel, which is opaque
    /// and therefore wrong over a frosted panel.
    var plain = false

    var body: some View {
        ZStack(alignment: .trailing) {
            // Two whole fields rather than one with a swapped style: a
            // `TextFieldStyle` has no type-erased form, so the branch has to be
            // above it.
            if plain {
                TextField("", text: $text)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 3)
                    .frame(width: width)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.05)))
            } else {
                TextField("", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
                    .frame(width: width)
            }
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .padding(.trailing, 5)
                .help("Clear this field")
                // A click here is about the field, not about leaving the panel.
                .focusable(false)
            }
        }
    }
}

private struct FieldMenu<Content: View>: View {
    let summary: String
    @ViewBuilder var content: () -> Content

    var body: some View {
        Menu {
            content()
        } label: {
            // The label carries the width, because `.borderedButton` sizes its
            // box to its content and ignores a frame applied outside it — which
            // is why an earlier attempt left every menu 57pt wide. Greedy
            // rather than fixed, so a menu fills its row exactly as the text
            // fields do and every box on the panel shares both edges.
            Text(summary)
                .font(.system(size: 12))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: Field.width - Field.menuInset, alignment: .leading)
        }
        // The system's own bordered menu rather than a box drawn here. A custom
        // label under `.borderlessButton` lost its background entirely and drew
        // as a bare chevron — worse than the mismatch it was meant to fix. This
        // is the same control AppKit gives a pop-up button, so an enum and a
        // reference wear identical chrome.
        .menuStyle(.borderedButton)
    }
}

private struct ReferencePicker: View {
    let candidates: [Daemon.Reference]
    /// Set when the list could not be fetched, as opposed to being genuinely
    /// empty. The two look the same in a menu and are not the same problem.
    let problem: String?
    let many: Bool
    @Binding var picked: [String]

    var body: some View {
        FieldMenu(summary: summary) {
            if let problem {
                Text("Couldn't load: \(problem)")
            } else if candidates.isEmpty {
                Text("Nothing of that type yet")
            } else {
                if !picked.isEmpty {
                    Button("Clear") { picked = [] }
                    Divider()
                }
                ForEach(sorted) { c in
                    Button {
                        toggle(c.id)
                    } label: {
                        // A tick rather than a separate selected list: the menu
                        // is where you look to see what is on.
                        Label(c.title, systemImage: picked.contains(c.id) ? "checkmark" : "")
                    }
                }
            }
        }
    }

    /// The library hands these back newest-first, which is an order nobody can
    /// see. Sorted the way a list of names should be.
    private var sorted: [Daemon.Reference] {
        candidates.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    private var summary: String {
        if problem != nil { return "unavailable" }
        if picked.isEmpty { return "—" }
        let names = Field.ordered(picked.compactMap { id in candidates.first { $0.id == id }?.title })
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
