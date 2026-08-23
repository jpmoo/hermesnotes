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
        win.title = "Hermes Notes"
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

    /// Built once at launch, not when a window opens.
    ///
    /// A menu bar installed on an app that has just changed activation policy is
    /// drawn and connected to nothing — the Apple menu included. Saying what the
    /// app is at launch and building the menu then is what makes it work.
    static func installMainMenu() {
        // No guard on there already being one. AppKit synthesises a menu for a
        // regular app that ships no nib, so "install only if absent" meant
        // never installing — which is why there was no View menu and no
        // Command-R. Ours replaces whatever was made for us.
        let main = NSMenu()

        // The first menu is the application menu, whatever its title.
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "About Talaria",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Talaria", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(
            withTitle: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Talaria", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // The whole point of the menu: the standard editing keys. They carry no
        // target on purpose — they travel the responder chain to whatever has
        // focus, which is what makes them work inside a web view.
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
        view.addItem(withTitle: "Open Hermes Notes", action: #selector(openHome), keyEquivalent: "0").target = shared
        view.addItem(.separator())
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = shared
        view.addItem(withTitle: "Back", action: #selector(goBack), keyEquivalent: "[").target = shared
        view.addItem(withTitle: "Forward", action: #selector(goForward), keyEquivalent: "]").target = shared
        viewItem.submenu = view
        main.addItem(viewItem)

        // macOS expects a Window menu to exist and fills it in itself.
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
        NSLog("talaria: main menu installed — \(main.items.map { $0.submenu?.title ?? $0.title })")
    }

    @objc private func openHome() { show() }

    @objc private func reload() { web?.reload() }
    @objc private func goBack() { web?.goBack() }
    @objc private func goForward() { web?.goForward() }
}
