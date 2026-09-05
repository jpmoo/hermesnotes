// Asking the compositor to blur what is behind a window.
//
// **Why this exists at all.** Frosted glass on Wayland is not something a
// client draws; it is something the compositor does behind a surface, and only
// when the surface asks. The asking is `ext-background-effect-v1`, a Wayland
// protocol. Six other routes were tried first and every one of them is closed
// from Python:
//
//   - `KWindowEffects::enableBlurBehind` — the class does not exist in this KF6
//     build. Zero symbols in `libKF6WindowSystem.so.6` or either backend plugin.
//   - A KWin script — `opacity` is the only relevant property on a window
//     object; all 160 were enumerated.
//   - `org.kde.KWin.ScreenShot2`, to fake it with a blurred capture — refuses
//     with `NoAuthorized`; it is allowlisted to Spectacle and the portal.
//   - `pywayland`, to speak the protocol from Python — not installed, and not
//     packaged for this distribution.
//
// And one dead end worth recording, because it looked like the answer and was
// not: `ext_background_effect_manager_v1`, the KDE-specific protocol every guide and
// every older article names. KWin does not advertise it any more. Enumerating
// all 66 globals is what found the replacement — a standard `ext-` protocol
// with a different name — after the KDE one had already been generated,
// compiled and linked against nothing.
//   - `QtWaylandClient` from PySide6 — the module is not exposed.
//   - `platformNativeInterface()` from PySide6 — not exposed either.
//
// So the protocol is spoken here, in the one language that can reach it, and
// Python calls in through three `extern "C"` functions. The whole binding is
// this file; there is no build system, no shiboken, and nothing generated at
// runtime.
//
// **The surface has to be Qt's own.** A second Wayland connection cannot
// reference a surface the first one created, so this does not open a display of
// its own: it borrows Qt's, through the public native interfaces
// `QWaylandApplication::display()` and `QWaylandWindow::surface()`. That is the
// reason the Qt development headers were needed and the reason nothing simpler
// would have done.

#include <QtGui/QGuiApplication>
#include <QtGui/QWindow>
#include <QtGui/qguiapplication_platform.h>
// `QPlatformNativeInterface` rather than `qplatformwindow_p.h`.
//
// The typed interface `QNativeInterface::Private::QWaylandWindow` is the
// tidier way to reach a surface, but its header chains into
// `QtCore/private/qglobal_p.h` and therefore into `qt6-base-private-dev` — a
// whole package for one accessor. This asks the platform plugin by name
// instead, which is a string lookup rather than a type, and needs nothing that
// is not already installed.
#include <QtGui/qpa/qplatformnativeinterface.h>

#include <wayland-client.h>
#include <cstdio>

#include "ext-background-effect-v1-client-protocol.h"

namespace {

ext_background_effect_manager_v1 *g_manager = nullptr;
bool g_looked = false;

int g_seen = 0;

void registryGlobal(void *, wl_registry *registry, uint32_t name,
                    const char *interface, uint32_t version)
{
    ++g_seen;
    if (qEnvironmentVariableIsSet("TALARIA_BLUR_DEBUG"))
        fprintf(stderr, "  global: %s v%u\n", interface, version);
    if (qstrcmp(interface, ext_background_effect_manager_v1_interface.name) == 0) {
        // Version 1 is all this needs: create, set_region, commit. Asking for
        // more than the compositor offers is a protocol error and a dead client.
        g_manager = static_cast<ext_background_effect_manager_v1 *>(
            wl_registry_bind(registry, name, &ext_background_effect_manager_v1_interface,
                             version < 1 ? version : 1));
    }
}

void registryGlobalRemove(void *, wl_registry *, uint32_t) {}

const wl_registry_listener kRegistryListener = { registryGlobal, registryGlobalRemove };

wl_display *display()
{
    auto *app = qGuiApp;
    if (!app)
        return nullptr;
    auto *wayland = app->nativeInterface<QNativeInterface::QWaylandApplication>();
    return wayland ? wayland->display() : nullptr;
}

/// Find the blur manager once, on Qt's own connection.
ext_background_effect_manager_v1 *manager()
{
    if (g_looked)
        return g_manager;
    g_looked = true;

    wl_display *d = display();
    if (!d)
        return nullptr;

    // **A queue of our own, and this is the whole difference between working
    // and silently finding nothing.**
    //
    // The display belongs to Qt, and Qt dispatches its default queue from its
    // own event loop. A plain `wl_display_roundtrip` here races that loop for
    // the same events: Qt's thread reads them, the registry listener below
    // never fires, and this reports that the compositor offers no blur — while
    // a standalone probe on the same machine lists the global happily. That is
    // exactly how this failed, twice, and it looks identical to the protocol
    // being absent.
    //
    // Assigning the registry to a private queue takes our events out of Qt's
    // way. It is the documented way for a library to use a display it does not
    // own, and the only correct one.
    wl_event_queue *queue = wl_display_create_queue(d);
    if (!queue)
        return nullptr;

    wl_registry *registry = wl_display_get_registry(d);
    wl_proxy_set_queue(reinterpret_cast<wl_proxy *>(registry), queue);
    wl_registry_add_listener(registry, &kRegistryListener, nullptr);
    // Two round trips: the first delivers the globals, the second the events
    // that binding one produces.
    wl_display_roundtrip_queue(d, queue);
    wl_display_roundtrip_queue(d, queue);
    wl_registry_destroy(registry);

    // The manager is moved back to the default queue: it is long-lived, it has
    // no events we listen for, and leaving it on a queue nobody dispatches
    // would strand anything the compositor did send.
    if (g_manager)
        wl_proxy_set_queue(reinterpret_cast<wl_proxy *>(g_manager), nullptr);
    wl_event_queue_destroy(queue);
    return g_manager;
}

wl_surface *surfaceOf(QWindow *window)
{
    if (!window || !qGuiApp)
        return nullptr;
    QPlatformNativeInterface *ni = qGuiApp->platformNativeInterface();
    if (!ni)
        return nullptr;
    // "surface" is what the Wayland plugin calls it. A window that has not been
    // shown has none yet, which is a normal answer rather than a failure — see
    // the note on the return value below.
    return static_cast<wl_surface *>(ni->nativeResourceForWindow("surface", window));
}

} // namespace

extern "C" {

/// Whether the compositor offers blur at all. Cheap after the first call.
int talaria_blur_available()
{
    return manager() != nullptr;
}

/// How many globals the registry walk actually saw. Diagnosis only.
int talaria_blur_globals_seen()
{
    manager();
    return g_seen;
}

/**
 * Blur everything behind this window.
 *
 * `pointer` is a `QWindow *`, handed over from Python as an integer by
 * `shiboken6.getCppPointer`. Passing it as an opaque value rather than a typed
 * object is what lets this stay a plain shared library with no binding
 * machinery.
 *
 * A null region means the whole surface, which is what a frosted panel wants —
 * the alternative is describing the rounded corners in a region, and the
 * corners are the page's business rather than the compositor's.
 *
 * Returns 1 on success, 0 if blur is unavailable or the window has no surface
 * yet. The second case is ordinary rather than exceptional: a window that has
 * not been shown has nothing to blur behind, and the caller is expected to ask
 * again once it has.
 */
int talaria_blur_enable(void *pointer)
{
    ext_background_effect_manager_v1 *m = manager();
    if (!m)
        return 0;

    wl_surface *surface = surfaceOf(reinterpret_cast<QWindow *>(pointer));
    if (!surface)
        return 0;

    ext_background_effect_surface_v1 *effect =
        ext_background_effect_manager_v1_get_background_effect(m, surface);
    if (!effect)
        return 0;

    // A null region means the whole surface, which is what a frosted panel
    // wants — describing the rounded corners in a region is the page's business
    // rather than the compositor's.
    ext_background_effect_surface_v1_set_blur_region(effect, nullptr);
    // Kept, not destroyed. Unlike the KDE protocol this replaced, the effect
    // lives only as long as its object: destroying it here removes the blur
    // again, immediately and invisibly.
    (void)effect;

    wl_display *d = display();
    if (d)
        wl_display_flush(d);
    return 1;
}

/// Stop blurring behind this window.
int talaria_blur_disable(void *pointer)
{
    // The protocol has no "unset": blur ends when the effect object is
    // destroyed, and the object is held by whoever created it. Nothing here
    // tracks them, because a panel that exists wants blur for as long as it
    // exists — so this reports that it did nothing rather than pretending.
    (void)pointer;
    return 0;
    /* unreachable, kept so the shape of the API stays honest:
    wl_display *d = display();
    if (d)
        wl_display_flush(d);
    return 1; */
}

} // extern "C"
