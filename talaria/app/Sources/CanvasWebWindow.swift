import AppKit
import WebKit

/**
 The canvas, drawn in a web view.

 Stage three of moving the renderer out of AppKit, and deliberately a *second*
 window rather than a replacement. `CanvasSurface` is six thousand lines of
 working software somebody uses; swapping it out before the new one can do what
 it does would be trading a finished thing for a partial one. The two run side
 by side until the web one is at parity, and then the Swift one goes.

 Everything it needs arrives over `DaemonScheme`, which carries the page's
 ordinary-looking requests into the daemon's Unix socket. There is no server,
 no port, and nothing for the window itself to know about the canvas — it is a
 frame around a page.
 */
@MainActor
final class CanvasWebWindow: NSObject, NSWindowDelegate, WKNavigationDelegate {
    static let shared = CanvasWebWindow()

    private var window: NSWindow?
    private var web: WKWebView?
    /// Kept, because the window has to be able to tell it to let go of anything
    /// still in flight before the view it would answer disappears.
    private var scheme: DaemonScheme?

    func show() {
        if let window {
            // Already open: bring it forward and re-read, because the document
            // may have been changed by the desk's canvas or by Canvas Chat
            // while this was behind something.
            reload()
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }

        let config = WKWebViewConfiguration()
        let handler = DaemonScheme(socketPath: Daemon.socketPath)
        config.setURLSchemeHandler(handler, forURLScheme: DaemonScheme.scheme)
        scheme = handler
        let home = URL(string: DaemonScheme.origin + "/canvas/app/index.html")!
        // Developer tools on. This page is being written; being unable to open
        // a console on it would mean debugging a canvas by screenshot.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.load(URLRequest(url: home))

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        win.title = "Canvas"
        win.contentView = view
        win.delegate = self
        win.center()
        // Named, so macOS restores it where it was left rather than centered
        // over whatever is underneath.
        win.setFrameAutosaveName("TalariaCanvasWeb")

        window = win
        web = view
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        win.makeKeyAndOrderFront(nil)
    }

    func reload() {
        web?.reload()
    }

    /**
     A link on a node goes to Hermes, not over the canvas.

     A block's badge carries its address, and following it in place would
     replace the drawing with a web page and leave no way back — the window has
     no address bar and no Back button, because until now it had one page. So
     anything that is not the canvas itself is handed on: Hermes to the window
     that knows what a Hermes link means, everything else to the browser.
     */
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if url.scheme == DaemonScheme.scheme {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        Opener.open(url)
    }

    func windowWillClose(_ notification: Notification) {
        // Before the view goes, not after. A request still on the socket comes
        // back to a task whose web view has been released, and messaging that
        // is a segmentation fault inside `objc_release` rather than an error
        // anybody can catch.
        scheme?.cancelAll()
        scheme = nil
        window = nil
        web = nil
        // Back to a menu-bar tool when nothing is open, the same rule the
        // Hermes window follows: an app with no windows sitting in the Dock is
        // a puzzle for whoever finds it there.
        if NSApp.windows.allSatisfy({ !$0.isVisible || $0 is NSPanel }) {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}
