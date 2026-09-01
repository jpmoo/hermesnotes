import AppKit
import SwiftUI

/**
 Everything Talaria needed a text editor for, in a window.

 Wearing Glance's material rather than a stock settings sheet, because it is the
 same application and should look like it — but not Glance's behavior. This one
 does not dismiss when you click away, and that is a deliberate difference: the
 board and the assistant can afford it because they are cheap to summon again,
 while a panel you leave to go and copy an access key out of a browser must
 still be there, with what you typed in it, when you come back.
 */

/// Posted after a successful save, so the delegate can restart the daemon and
/// re-register the hotkeys without this view knowing either exists.
extension Notification.Name {
    static let talariaConfigSaved = Notification.Name("talaria.configSaved")
}

@MainActor
final class SettingsModel: ObservableObject {
    @Published var config = TalariaConfig()
    /// What was on disk when this opened, so the Save button can say whether
    /// there is anything to save.
    @Published private(set) var saved = TalariaConfig()

    @Published var producerReach: Reach?
    @Published var testingProducer = false

    @Published var models: [EmbedModel] = []
    @Published var embedderReach: Reach?
    @Published var testingEmbedder = false

    @Published var problems: [String] = []
    @Published var status: String?
    @Published var busy = false

    /// One bundle id per line, which is a friendlier thing to edit than a JSON
    /// array and converts back losslessly.
    @Published var excludeText = ""

    var dirty: Bool { config != saved }

    /// Whether the embedding model is about to change under a built index.
    var modelChanging: Bool {
        !saved.glanceModel.isEmpty && config.glanceModel != saved.glanceModel
    }

    var embedderIsLocal: Bool { Probe.isLocal(config.glanceUrl) }

    func load() {
        let c = ConfigStore.load()
        config = c
        saved = c
        excludeText = c.contextExclude.joined(separator: "\n")
        problems = []
        status = ConfigStore.exists ? nil : "No settings yet — fill these in and Talaria will start syncing."
        producerReach = nil
        // The saved address, asked about on open. Probing an embedding server
        // reveals nothing but that we are here, and the address is one the user
        // configured — but a freshly typed one is not asked about until they
        // press Connect.
        refreshModels()
    }

    private func syncExclude() {
        config.contextExclude = excludeText
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    func testProducer() {
        syncExclude()
        testingProducer = true
        producerReach = nil
        let origin = config.origin, key = config.accessKey
        Task.detached(priority: .userInitiated) {
            let reach = Probe.producer(origin: origin, key: key)
            await MainActor.run {
                self.testingProducer = false
                self.producerReach = reach
            }
        }
    }

    func refreshModels() {
        testingEmbedder = true
        embedderReach = nil
        let url = config.glanceUrl
        Task.detached(priority: .userInitiated) {
            let found = Probe.models(at: url)
            await MainActor.run {
                self.testingEmbedder = false
                self.models = found.models
                self.embedderReach = found.reach
                // Never silently repoint the model. If what is configured is not
                // installed, that is worth seeing rather than correcting — the
                // index was built with it, and choosing a different one is a
                // decision with a cost.
                if !found.models.isEmpty,
                   !found.models.contains(where: { $0.name == self.config.glanceModel }),
                   self.config.glanceModel.isEmpty {
                    self.config.glanceModel = found.models[0].name
                }
            }
        }
    }

    func save() {
        syncExclude()
        let found = ConfigStore.problems(config)
        problems = found
        guard found.isEmpty else {
            status = nil
            return
        }
        busy = true
        status = "Saving…"
        do {
            try ConfigStore.save(config)
        } catch {
            busy = false
            problems = ["Couldn't write \(ConfigStore.path): \(error.localizedDescription)"]
            status = nil
            return
        }
        saved = config
        NotificationCenter.default.post(name: .talariaConfigSaved, object: nil)
        status = "Saved. Restarting the daemon…"

        // Wait for the socket to answer again rather than claiming it has. A
        // restart that fails — a key the producer refuses, a config the daemon
        // will not parse — looks exactly like a restart that worked if nobody
        // goes and checks.
        Task.detached(priority: .userInitiated) {
            for _ in 0..<40 {
                try? await Task.sleep(nanoseconds: 500_000_000)
                if (try? Daemon.health()) != nil {
                    await MainActor.run {
                        self.busy = false
                        self.status = "Saved. The daemon is back up."
                    }
                    return
                }
            }
            await MainActor.run {
                self.busy = false
                self.status = "Saved, but the daemon hasn't come back. See ~/Library/Logs/talaria.log"
            }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: SettingsModel

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    hermes
                    inference
                    glance
                    shortcuts
                    desktop
                }
                .padding(.horizontal, 20)
                .padding(.top, 18)
                .padding(.bottom, 20)
            }
            Divider().opacity(0.35)
            footer
        }
        .frame(width: 500, height: 620)
        .background(VisualEffect(radius: 0))
    }

    // MARK: Sections

    private var hermes: some View {
        section("Hermes Notes", "The library this mirrors, and the key that opens it.") {
            field("Address") {
                TextField("https://example.com/hermesnotes", text: $model.config.origin)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }
            field("Access key") {
                SecretField(text: $model.config.accessKey, prompt: "hn_…")
            }
            HStack(spacing: 8) {
                Button(action: model.testProducer) {
                    Text(model.testingProducer ? "Checking…" : "Test connection")
                }
                .disabled(model.testingProducer || model.config.origin.isEmpty)
                if model.testingProducer {
                    ProgressView().controlSize(.small).scaleEffect(0.7)
                }
                Spacer(minLength: 0)
            }
            if let reach = model.producerReach { verdict(reach) }

            field("Check every") {
                HStack(spacing: 6) {
                    TextField("", value: $model.config.pollSeconds, format: .number)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 64)
                        .multilineTextAlignment(.trailing)
                    Text("seconds while the network is up")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var inference: some View {
        section(
            "Chat",
            "Where Talaria's own chat thinks. Separate from the embedding above on purpose: that runs a small embedding model beside the words it embeds, and this needs a tool-capable chat model — llama3.1, qwen2.5 and the like — which is often on a different machine."
        ) {
            field("Server") {
                TextField("http://localhost:11434", text: $model.config.inferenceUrl)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }
            field("Model") {
                VStack(alignment: .leading, spacing: 4) {
                    TextField("llama3.1", text: $model.config.inferenceModel)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, design: .monospaced))
                    Text("It has to be able to call tools. A model that cannot will hold a conversation and change nothing on the canvas, which looks like a broken canvas rather than the wrong model.")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var glance: some View {
        section("Glance embedding", "Where the words in your front window are turned into a vector.") {
            field("Server") {
                HStack(spacing: 6) {
                    TextField("http://localhost:11434", text: $model.config.glanceUrl)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, design: .monospaced))
                        .onSubmit { model.refreshModels() }
                    Button(model.testingEmbedder ? "…" : "Connect") { model.refreshModels() }
                        .disabled(model.testingEmbedder)
                }
            }

            // The one thing on this panel somebody could get wrong without ever
            // finding out. Stated as a fact rather than as an alarm: pointing
            // this at a machine on the LAN is a trade a person is entitled to
            // make, and it is only a problem if they make it without knowing.
            if model.embedderIsLocal {
                note(icon: "checkmark.shield", tone: .secondary,
                     "On this machine. What you are working on is embedded here and never sent anywhere.")
            } else {
                note(icon: "exclamationmark.triangle.fill", tone: .caution,
                     "Not on this laptop. The text of whatever you have open — the document, not just its title — will be sent to \(host(model.config.glanceUrl)) every time Glance runs. Only point this at a machine you trust with what you write.")
            }

            if let reach = model.embedderReach { verdict(reach) }

            field("Model") {
                Picker("", selection: $model.config.glanceModel) {
                    ForEach(pickable) { m in
                        Text(label(for: m)).tag(m.name)
                    }
                }
                .labelsHidden()
                .disabled(pickable.isEmpty)
            }

            if model.modelChanging {
                note(icon: "arrow.triangle.2.circlepath", tone: .secondary,
                     "Changing the model throws away the vectors already built and starts again — a few hundred calls, in the background. Scores mean nothing across two different models, so there is no way to keep them.")
            }

            field("Less similar") {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Slider(value: $model.config.glanceThreshold, in: 0...1, step: 0.01)
                            .frame(width: Field.width - 70)
                        Text(model.config.glanceThreshold == 0
                             ? "off"
                             : String(format: "%.2f", model.config.glanceThreshold))
                            .font(.system(size: 11, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(model.config.glanceThreshold == 0 ? .tertiary : .secondary)
                            .frame(width: 34, alignment: .leading)
                    }
                    Text("Anything scoring below this is filed under \u{201C}less similar\u{201D} instead of the main list. Zero is off. Every hit shows its score, so the way to pick a number is to glance at a few and see where the useful ones stop.")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            field("Done") {
                VStack(alignment: .leading, spacing: 4) {
                    Toggle(isOn: $model.config.glanceSeparateDone) {
                        Text("Put finished things in their own section")
                            .font(.system(size: 11))
                    }
                    .toggleStyle(.checkbox)
                    Text("Read through the type's own status and complete values, so it follows whatever a type calls finished rather than the word \u{201C}done\u{201D}. Things with no status at all — a note, a person — are never filed here.")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            field("Undated") {
                VStack(alignment: .leading, spacing: 4) {
                    Toggle(isOn: $model.config.glanceUndatedFurtherOut) {
                        Text("Include undated items in \u{201C}Further Out/Undated\u{201D}")
                            .font(.system(size: 11))
                    }
                    .toggleStyle(.checkbox)
                    Text("Off, a note or a person with no date sits in the main list — which is most of what you want while writing something. On, they move below the divider with the far-off ones, leaving the top of the list to what is actually happening this week.")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var shortcuts: some View {
        section("Shortcuts", "Written as shift+opt+g. A shortcut that registers swallows the keystroke, so an Option combination composes nothing — but if something else already owns it, it does nothing here and types a dead-key character into whatever you are writing. Check ~/Library/Logs/talaria.log if one stops working.") {
            field("Collections") { hotkeyField($model.config.boardHotkey, "shift+opt+c") }
            field("Ask Hermes") { hotkeyField($model.config.assistantHotkey, "shift+opt+a") }
            field("Glance") { hotkeyField($model.config.glanceHotkey, "shift+opt+g") }
            field("New block") { hotkeyField($model.config.composeHotkey, "shift+opt+h") }
            field("Menu bar icon") {
                TextField("bubble.left.and.bubble.right", text: $model.config.menuBarSymbol)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }
        }
    }

    private var desktop: some View {
        section("Desktop", "What Talaria watches, and what it is told not to.") {
            field("Never record") {
                VStack(alignment: .leading, spacing: 4) {
                    TextEditor(text: $model.excludeText)
                        .font(.system(size: 11, design: .monospaced))
                        .scrollContentBackground(.hidden)
                        .frame(height: 62)
                        .padding(4)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(Color.primary.opacity(0.05))
                        )
                    Text("One bundle id per line. These are invisible to the context record — and so to ranking and defaulting, which is the price of being invisible.")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            field("aerospace") {
                VStack(alignment: .leading, spacing: 4) {
                    TextField("found automatically", text: $model.config.aerospaceCli)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, design: .monospaced))
                    Text("Only needed if `talaria doctor` says the workspace is missing while `aerospace list-workspaces --focused` works in a terminal — a LaunchAgent's PATH is not your shell's.")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.problems.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(model.problems, id: \.self) { p in
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Image(systemName: "exclamationmark.circle.fill").font(.system(size: 9))
                            Text(p).font(.system(size: 11))
                        }
                        .foregroundStyle(Theme.danger)
                    }
                }
            }
            HStack(spacing: 8) {
                Button {
                    NSWorkspace.shared.selectFile(
                        ConfigStore.path, inFileViewerRootedAtPath: ConfigStore.directory
                    )
                } label: {
                    Text("config.json")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help(ConfigStore.path)

                if let status = model.status {
                    Text(status).font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                if model.busy { ProgressView().controlSize(.small).scaleEffect(0.7) }
                Button("Save") { model.save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.busy || !model.dirty)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    // MARK: Pieces

    /// The saved model always appears, installed or not. A picker whose
    /// selection is absent from its own options draws blank and then quietly
    /// changes what it is bound to — which here would repoint an index without
    /// anybody asking.
    private var pickable: [EmbedModel] {
        var list = model.models
        let current = model.config.glanceModel
        if !current.isEmpty, !list.contains(where: { $0.name == current }) {
            list.insert(EmbedModel(name: current, dimensions: nil, embeds: true), at: 0)
        }
        return list
    }

    private func label(for m: EmbedModel) -> String {
        var parts = [m.name]
        if let d = m.dimensions { parts.append("\(d)") }
        if !model.models.contains(where: { $0.name == m.name }) { parts.append("not installed") }
        return parts.joined(separator: "  ·  ")
    }

    private func host(_ url: String) -> String {
        URL(string: url)?.host ?? "another machine"
    }

    private func hotkeyField(_ binding: Binding<String>, _ placeholder: String) -> some View {
        TextField(placeholder, text: binding)
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 12, design: .monospaced))
    }

    private enum Tone { case secondary, caution }

    private func note(icon: String, tone: Tone, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon).font(.system(size: 10))
            Text(text).font(.system(size: 10.5)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(tone == .caution ? Color(hex: "c47f2e") ?? .orange : Color.secondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill((tone == .caution ? Color(hex: "c47f2e") ?? .orange : Color.primary).opacity(0.07))
        )
    }

    private func verdict(_ reach: Reach) -> some View {
        let (icon, color): (String, Color) = {
            switch reach {
            case .ok: return ("checkmark.circle.fill", Theme.accent)
            case .warn: return ("exclamationmark.triangle.fill", Color(hex: "c47f2e") ?? .orange)
            case .bad: return ("xmark.circle.fill", Theme.danger)
            }
        }()
        return HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: icon).font(.system(size: 10))
            Text(reach.detail).font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(color)
    }

    private func section<Content: View>(
        _ title: String, _ blurb: String, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Theme.chrome(12, weight: .semibold))
                Text(blurb)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            content()
        }
    }

    private func field<Content: View>(
        _ label: String, @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .trailing)
                .padding(.top, 4)
            content()
            Spacer(minLength: 0)
        }
    }
}

/**
 An access key, hidden by default and revealable.

 Two fields swapped rather than one field with a flag, because SwiftUI rebuilds
 the view when `SecureField` becomes `TextField` and a single binding keeps the
 text across the swap. Hidden by default because this is a credential and a
 settings window is a thing people open while somebody is looking over their
 shoulder; revealable because a key you cannot read is a key you cannot check
 against the one in your clipboard.
 */
private struct SecretField: View {
    @Binding var text: String
    let prompt: String
    @State private var revealed = false

    var body: some View {
        HStack(spacing: 6) {
            Group {
                if revealed {
                    TextField(prompt, text: $text)
                } else {
                    SecureField(prompt, text: $text)
                }
            }
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 12, design: .monospaced))

            Button {
                revealed.toggle()
            } label: {
                Image(systemName: revealed ? "eye.slash" : "eye")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help(revealed ? "Hide" : "Show")
        }
    }
}
