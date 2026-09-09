import AppKit
import SwiftUI
import UniformTypeIdentifiers

/**
 A finished export, before anything is done with it.

 Exporting used to ask where to put the file and then draw it, which is the
 wrong order for this particular thing: a canvas export is the whole extent of
 the drawing rather than the part anybody was looking at, so what comes out is
 routinely a surprise — a stray node three screens to the left, a region that
 grew when nobody noticed. Looking first costs one window and saves the round
 trip of saving, opening, tutting, and going back.

 The value is the file itself. `image` is only for looking at, and is a PNG even
 when the export is a PDF: what is being previewed is the drawing rather than
 the container.
 */
struct ExportPreview: Identifiable {
    let id = UUID()
    let data: Data
    /// Whether this is a PNG. A PDF otherwise — the only two kinds there are.
    let png: Bool
    let image: NSImage?

    var filename: String { png ? "Canvas.png" : "Canvas.pdf" }
    var mediaType: String { png ? "image/png" : "application/pdf" }
    var type: UTType { png ? .png : .pdf }
}

/**
 The preview, with the three things somebody might want to do with it.

 **Nothing here closes the window.** Saving and sending are not alternatives —
 keeping a copy on disk *and* putting one on today's page is an ordinary thing
 to want, and a sheet that vanished after the first of them would make the
 second a matter of exporting all over again. Dismiss is a decision, and it is
 the only thing that ends this.
 */
struct ExportPreviewSheet: View {
    let preview: ExportPreview
    let dismiss: () -> Void

    /// What happened, once something has. Kept after the action rather than
    /// flashed, because the window stays open and a person who saved a minute
    /// ago should still be able to see that they did.
    @State private var saved: String?
    @State private var sent: String?
    @State private var trouble: String?
    @State private var sending = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(preview.png ? "PNG export" : "PDF export")
                    .font(Theme.chrome(12, weight: .semibold))
                Text(size)
                    .font(Theme.chrome(11))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider().opacity(0.4)

            // Checkerboard behind it, because a PNG export of a canvas is
            // transparent everywhere nobody drew — and a transparent image on a
            // white sheet looks like a white image, which is the one thing a
            // preview must not do.
            ZStack {
                Checkerboard()
                if let image = preview.image {
                    Image(nsImage: image)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                        .padding(12)
                } else {
                    Text("This export cannot be shown, but it can still be saved")
                        .font(Theme.chrome(11))
                        .foregroundStyle(.secondary)
                        .padding()
                }
            }
            .frame(minWidth: 420, minHeight: 300)

            Divider().opacity(0.4)

            if let note = trouble ?? saved ?? sent {
                Text(note)
                    .font(Theme.chrome(11))
                    .foregroundStyle(trouble == nil ? .secondary : Theme.danger)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
            }

            HStack(spacing: 10) {
                Button("Save…") { save() }
                Button(sending ? "Sending…" : "Send to Today's Note") { send() }
                    .disabled(sending)
                Spacer(minLength: 0)
                Button("Dismiss") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .frame(minWidth: 460, minHeight: 420)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var size: String {
        let kb = Double(preview.data.count) / 1024
        return kb < 1024 ? String(format: "%.0f KB", kb) : String(format: "%.1f MB", kb / 1024)
    }

    private func save() {
        trouble = nil
        guard let url = CanvasFiles.destination(preview.type, named: preview.filename) else { return }
        if let bad = CanvasFiles.write(preview.data, to: url) {
            trouble = bad
        } else {
            saved = "Saved to \(url.lastPathComponent)"
        }
    }

    private func send() {
        trouble = nil
        sending = true
        let file = preview.filename
        let mime = preview.mediaType
        let data = preview.data
        // Off the main thread: this is a network write through the daemon, and
        // a sheet that stops redrawing while it happens reads as a hang.
        Task.detached(priority: .userInitiated) {
            let bad = Daemon.attachToToday(filename: file, mediaType: mime, data: data)
            await MainActor.run {
                sending = false
                if let bad { trouble = bad } else { sent = "Added to today's note" }
            }
        }
    }
}

/// The pattern that says "nothing was drawn here" rather than "this is white".
private struct Checkerboard: View {
    var body: some View {
        Canvas { context, size in
            let side: CGFloat = 10
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
            var y: CGFloat = 0
            var row = 0
            while y < size.height {
                var x: CGFloat = (row % 2 == 0) ? 0 : side
                while x < size.width {
                    context.fill(
                        Path(CGRect(x: x, y: y, width: side, height: side)),
                        with: .color(.black.opacity(0.06))
                    )
                    x += side * 2
                }
                y += side
                row += 1
            }
        }
    }
}
