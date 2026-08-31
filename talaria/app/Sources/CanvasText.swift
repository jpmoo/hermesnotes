import AppKit
import SwiftUI

/**
 The words on a canvas item, and the small amount of markup they may carry.

 Markdown, held as the plain string it looks like. Not an archived attributed
 string, for the same reason colours are hex and pictures are files: the canvas
 is one JSON document somebody can open and read, and `**like this**` survives
 that where a base64 blob does not. It is also what Hermes writes, so the day
 these are exchanged there is nothing to translate.

 Bold, italic, underline and links, and deliberately nothing else. Headings,
 lists and quotes are the shape of a document; a label on a diagram is a phrase
 with emphasis in it. Adding the rest would mean deciding how a heading looks
 inside a circle, which is a question nobody asked.
 */
enum CanvasText {
    /// `<u>` because markdown has no underline and never has. Kept as the HTML
    /// tag rather than invented as `__` — which markdown already spends on bold
    /// — so a file written here still reads as markdown everywhere else, with
    /// one tag in it that other renderers already understand.
    private static let underline = try! NSRegularExpression(pattern: "<u>(.*?)</u>", options: [.dotMatchesLineSeparators])
    /// A bare address, made clickable without anybody having to write brackets.
    private static let bareLink = try! NSRegularExpression(pattern: #"(?<![(\[])\bhttps?://[^\s<>)\]]+"#)

    /**
     The words as they are drawn.

     Underline is pulled out before the markdown parser sees it, because the
     parser would either drop the tag or print it. What is left is ordinary
     markdown, and the ranges that were wrapped get the attribute put back
     afterwards — matched by looking for the text that was inside the tag, which
     is enough here and would not be in a document with repeats worth worrying
     about.
     */
    static func attributed(_ markdown: String) -> AttributedString {
        var source = markdown
        var underlined: [String] = []
        // Innermost-out, so nested tags do not confuse the ranges.
        while let m = underline.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)),
              let whole = Range(m.range, in: source),
              let inner = Range(m.range(at: 1), in: source) {
            let text = String(source[inner])
            underlined.append(text)
            source.replaceSubrange(whole, with: text)
        }

        source = autolinked(source)

        var out: AttributedString
        do {
            out = try AttributedString(
                markdown: source,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
            )
        } catch {
            // Unparseable markdown is still somebody's words. Shown as typed
            // rather than shown as nothing.
            out = AttributedString(markdown)
        }

        for text in underlined where !text.isEmpty {
            var from = out.startIndex
            while from < out.endIndex, let found = out[from...].range(of: text) {
                out[found].underlineStyle = .single
                from = found.upperBound
            }
        }
        return out
    }

    /// Bare addresses wrapped so the parser makes them links.
    private static func autolinked(_ s: String) -> String {
        var result = s
        let matches = bareLink.matches(in: s, range: NSRange(s.startIndex..., in: s)).reversed()
        for m in matches {
            guard let r = Range(m.range, in: result) else { continue }
            let url = String(result[r])
            result.replaceSubrange(r, with: "[\(url)](\(url))")
        }
        return result
    }

    /// The words with the markup taken off, for measuring. A box sized from the
    /// source would be wide enough for asterisks nobody can see.
    static func plain(_ markdown: String) -> String {
        String(attributed(markdown).characters)
    }

    /// Wrap the selection, which is what every one of these shortcuts does.
    static func wrap(_ text: String, range: NSRange, with marker: String, close: String? = nil) -> (String, NSRange) {
        let closing = close ?? marker
        let ns = text as NSString
        guard range.location != NSNotFound, NSMaxRange(range) <= ns.length else { return (text, range) }
        let selected = ns.substring(with: range)

        // Already wrapped: take it off again, so the same key is the toggle it
        // looks like rather than a thing that only ever adds more asterisks.
        if selected.hasPrefix(marker), selected.hasSuffix(closing),
           selected.count >= marker.count + closing.count {
            let inner = String(selected.dropFirst(marker.count).dropLast(closing.count))
            let out = ns.replacingCharacters(in: range, with: inner)
            return (out, NSRange(location: range.location, length: (inner as NSString).length))
        }

        let wrapped = marker + selected + closing
        let out = ns.replacingCharacters(in: range, with: wrapped)
        // The same words stay selected, so a second shortcut applies to what the
        // first one did rather than to nothing.
        return (out, NSRange(location: range.location + (marker as NSString).length,
                             length: (selected as NSString).length))
    }
}

/**
 The editor, which is an `NSTextView` and had to become one.

 A SwiftUI `TextField` cannot say where the selection is, and every one of these
 shortcuts is "wrap what is selected". Without that, bold would have to mean
 "put two asterisks at the end and hope", which is not the feature.

 Plain text on purpose. The view edits markdown source and shows it as typed;
 what is *drawn* on the canvas the rest of the time is the rendered version.
 Editing rich text natively would look better for the few seconds a caret is in
 it and would mean storing an archive nobody can read, which is the trade this
 whole file declines.
 */
struct MarkdownField: NSViewRepresentable {
    @Binding var text: String
    let commit: () -> Void
    let changed: (String) -> Void
    let align: NSTextAlignment
    let color: NSColor

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MarkdownField
        init(_ parent: MarkdownField) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            parent.text = view.string
            parent.changed(view.string)
        }

        func textView(_ view: NSTextView, doCommandBy selector: Selector) -> Bool {
            // Return commits. Shift-Return is `insertNewline:` too on a text
            // view, so the modifier is read from the event rather than from the
            // selector — which is the same for both.
            if selector == #selector(NSResponder.insertNewline(_:)) {
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                    view.insertText("\n", replacementRange: view.selectedRange())
                    return true
                }
                parent.commit()
                return true
            }
            return false
        }

        /// One shortcut, applied to the selection.
        func apply(_ marker: String, close: String? = nil, in view: NSTextView) {
            let (next, range) = CanvasText.wrap(view.string, range: view.selectedRange(), with: marker, close: close)
            guard next != view.string else { return }
            view.string = next
            view.setSelectedRange(range)
            parent.text = next
            parent.changed(next)
        }
    }

    final class Field: NSTextView {
        weak var coord: Coordinator?

        /// The three shortcuts, caught before the responder chain has a chance
        /// to do something else with them — a text view with `isRichText` off
        /// answers ⌘B by beeping.
        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  let key = event.charactersIgnoringModifiers?.lowercased() else {
                return super.performKeyEquivalent(with: event)
            }
            switch key {
            case "b": coord?.apply("**", in: self); return true
            case "i": coord?.apply("*", in: self); return true
            case "u": coord?.apply("<u>", close: "</u>", in: self); return true
            default: return super.performKeyEquivalent(with: event)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.borderType = .noBorder

        let view = Field()
        view.coord = context.coordinator
        view.delegate = context.coordinator
        view.isRichText = false
        view.drawsBackground = false
        view.font = .systemFont(ofSize: 12)
        view.textColor = color
        view.alignment = align
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        // Smart substitutions turn a typed asterisk pair into something else and
        // a straight quote into a curly one, both of which change markdown into
        // text that looks like markdown.
        view.isAutomaticTextReplacementEnabled = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.string = text

        scroll.documentView = view
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
        if view.string != text { view.string = text }
        view.alignment = align
        view.textColor = color
    }
}
