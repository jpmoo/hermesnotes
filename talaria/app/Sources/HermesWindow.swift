import AppKit
import WebKit

/// Hermes in a window of its own.
///
/// The reason this exists rather than handing links to a browser: a deep link
/// should land on the thing it names. A wrapped copy of the site can be
/// registered for a scheme, but the one on this machine sends incoming URLs to
/// a renderer that has no listener for them, so they arrive and vanish. Talaria
/// already owns `talaria://` and already resolves an id to an address; giving it
/// somewhere to put the result closes the loop without a second wrapper.
@MainActor
final class HermesWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    static let shared = HermesWindow()

    private var window: NSWindow?
    private var web: WKWebView?
    private var origin: URL?

    /// Where Hermes lives, from the same config the daemon reads.
    private func configuredOrigin() -> URL? {
        if let origin { return origin }
        let path = NSHomeDirectory() + "/Library/Application Support/Talaria/config.json"
        guard let data = FileManager.default.contents(atPath: path),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let s = obj["origin"] as? String,
              let url = URL(string: s)
        else { return nil }
        origin = url
        return url
    }

    /// Whether an address belongs to this Hermes — anything else is somebody
    /// else's website and belongs in a browser.
    func isHermes(_ url: URL) -> Bool {
        guard let origin = configuredOrigin(), let host = url.host, let ours = origin.host else { return false }
        return host == ours && url.path.hasPrefix(origin.path)
    }

    func show(_ url: URL? = nil) {
        let view = ensureWindow()
        if let url {
            view.load(URLRequest(url: url))
        } else if view.url == nil, let home = configuredOrigin() {
            view.load(URLRequest(url: home))
        }
        // A Dock icon and a menu bar while the window is up: without them there
        // is no Edit menu, and no Edit menu means no cut, copy, paste or undo
        // in a window whose whole purpose is writing.
        NSApp.setActivationPolicy(.regular)
        installMainMenuIfNeeded()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    private func ensureWindow() -> WKWebView {
        if let web { return web }

        let config = WKWebViewConfiguration()
        // The default store is on disk, so a session survives quitting — being
        // asked to log in every launch would make this worse than a browser tab.
        config.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = true

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        win.title = "Hermes"
        win.contentView = view
        win.delegate = self
        win.isReleasedWhenClosed = false
        win.setFrameAutosaveName("talaria.hermes")
        win.center()

        window = win
        web = view
        return view
    }

    // MARK: Navigation

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // Hermes stays here; a link out of it goes to the browser, which is
        // where somebody else's website belongs.
        if url.scheme == "http" || url.scheme == "https", !isHermes(url) {
            decisionHandler(.cancel)
            NSWorkspace.shared.open(url)
            return
        }
        decisionHandler(.allow)
    }

    /// target="_blank" has no window to open; keep it in this one.
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            if isHermes(url) { webView.load(URLRequest(url: url)) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    func windowWillClose(_ notification: Notification) {
        // Back to a menu-bar tool when the window goes: an app with no windows
        // sitting in the Dock is a puzzle for whoever finds it there.
        NSApp.setActivationPolicy(.accessory)
    }

    // MARK: A menu, because a web view needs one

    private func installMainMenuIfNeeded() {
        guard NSApp.mainMenu == nil else { return }
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide Talaria", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Talaria", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // The whole point of the menu: the standard editing keys. Without these
        // a web view swallows ⌘C and ⌘V and there is no way to get them back.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
        view.addItem(withTitle: "Back", action: #selector(goBack), keyEquivalent: "[").target = self
        view.addItem(withTitle: "Forward", action: #selector(goForward), keyEquivalent: "]").target = self
        viewItem.submenu = view
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    @objc private func reload() { web?.reload() }
    @objc private func goBack() { web?.goBack() }
    @objc private func goForward() { web?.goForward() }
}
