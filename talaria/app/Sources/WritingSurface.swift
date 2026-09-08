import AppKit
import SwiftUI
import WebKit

/**
 The desk's writing surface: the shared page, in a web view.

 The page itself is `ui/writing.html`, written for the Linux shell and read here
 out of the app bundle without a line changed. That is deliberate — one document
 surface, two shells — and it is why `DaemonScheme` serves files as well as
 proxying the socket.

 **Nothing on it reaches Hermes Notes.** No blocks, no types, no interchange and
 no daemon: its documents are Markdown files under Application Support, answered
 by `/shell/writing` inside this process. It works with the daemon stopped and
 the network down, which is the whole specification of a blank page.

 A single web view, made once and kept. One made at the moment of a swipe
 arrives a frame late and loads in front of somebody, which is the same reason
 the desk builds both its other surfaces up front.
 */
struct WritingSurface: NSViewRepresentable {
    /// Whether what is behind the window shows through.
    ///
    /// Told to the page rather than drawn over it: `panel.css` already has a
    /// `solid` class that swaps the toolbar's and the sheet's see-through fill
    /// for an opaque one, and it is the Linux shell's switch for the same thing.
    /// Restyling from here would be a second answer to a question the page has
    /// already answered.
    var seeThrough: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Holds the scheme handler, and lets go of its work before the view dies.
    final class Coordinator: NSObject, WKNavigationDelegate {
        let scheme = DaemonScheme(socketPath: Daemon.socketPath)
        /// What the page was last told, so an unchanged value costs nothing.
        var told: Bool?
        /// What it should be, for the load that has not finished yet. A view is
        /// made and asked to update long before its page exists.
        var want = true

        func webView(_ view: WKWebView, didFinish _: WKNavigation!) {
            told = nil
            WritingSurface.tell(view, seeThrough: want, coordinator: self)
        }
    }

    /// One line of script, and only when the answer has changed.
    private static func tell(_ view: WKWebView, seeThrough: Bool, coordinator: Coordinator) {
        guard coordinator.told != seeThrough else { return }
        coordinator.told = seeThrough
        view.evaluateJavaScript(
            "document.documentElement.classList.toggle('solid', \(seeThrough ? "false" : "true"))",
            completionHandler: nil
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(context.coordinator.scheme, forURLScheme: DaemonScheme.scheme)

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        // The desk draws its own ground and may be see-through; a web view that
        // paints an opaque white page over it would be a white rectangle in the
        // middle of frosted glass.
        view.setValue(false, forKey: "drawsBackground")
        // The supported switch rather than a KVC poke at a private preferences
        // key. The private one is a guess about a name that has changed before.
        if #available(macOS 13.3, *) { view.isInspectable = true }
        view.load(URLRequest(url: URL(string: DaemonScheme.origin + "/ui/writing.html")!))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.want = seeThrough
        Self.tell(view, seeThrough: seeThrough, coordinator: context.coordinator)
    }

    /**
     Let go of anything still in flight before the view goes.

     A request outliving the view it was for is ordinary — a save landing as the
     desk closes — and answering one whose web view has been released is a
     segmentation fault inside `objc_release` rather than an error anybody can
     catch. This is the hook that says the view is going.
     */
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.scheme.cancelAll()
        view.stopLoading()
        view.navigationDelegate = nil
    }
}
