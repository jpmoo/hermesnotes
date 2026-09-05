"""
Frosted glass, through the one door that was open.

Blur on Wayland is the compositor's work, done behind a surface only when the
surface asks — and the asking is a Wayland protocol, `org_kde_kwin_blur`. Six
routes to it were tried from Python and every one is closed; the reasoning is
written at the top of `blur/talaria_blur.cpp` rather than repeated here.

What is left is a small C++ binding, loaded with `ctypes`. Python hands over the
`QWindow *` as an integer from `shiboken6.getCppPointer`, and the library does
the protocol work on Qt's own Wayland connection — it has to be Qt's, because a
second connection cannot reference a surface the first one created.

**Failure is silent and expected.** A desktop without the effect, a session that
is not Wayland, a library nobody built: all of them mean no frosting and no
complaint, because a panel that is merely opaque is a panel that still works.
"""

from __future__ import annotations

import ctypes
import os
import sys

LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "blur", "libtalaria_blur.so")

_lib: ctypes.CDLL | None = None
_looked = False
_said = False


def _library() -> ctypes.CDLL | None:
    global _lib, _looked
    if _looked:
        return _lib
    _looked = True
    if not os.path.isfile(LIB):
        return None
    try:
        lib = ctypes.CDLL(LIB)
        lib.talaria_blur_available.restype = ctypes.c_int
        lib.talaria_blur_enable.argtypes = [ctypes.c_void_p]
        lib.talaria_blur_enable.restype = ctypes.c_int
        lib.talaria_blur_disable.argtypes = [ctypes.c_void_p]
        lib.talaria_blur_disable.restype = ctypes.c_int
        _lib = lib
    except OSError:
        _lib = None
    return _lib


def available() -> bool:
    """Whether this compositor offers blur. Answered once, then remembered."""
    lib = _library()
    if lib is None:
        return False
    try:
        return bool(lib.talaria_blur_available())
    except Exception:  # noqa: BLE001
        return False


def _pointer(widget) -> int | None:
    """
    The `QWindow *` behind a widget, as an integer.

    `windowHandle()` is None until the widget has been shown — a window that
    does not exist yet has no surface to blur behind, which is why the caller
    asks again after showing rather than treating this as an error.
    """
    handle = widget.windowHandle()
    if handle is None:
        return None
    try:
        import shiboken6

        pointers = shiboken6.getCppPointer(handle)
    except Exception:  # noqa: BLE001
        return None
    return pointers[0] if pointers else None


def apply_to(widget) -> bool:
    """Blur what is behind this widget. False when that was not possible."""
    lib = _library()
    if lib is None:
        return False
    pointer = _pointer(widget)
    if pointer is None:
        return False
    try:
        ok = bool(lib.talaria_blur_enable(ctypes.c_void_p(pointer)))
    except Exception:  # noqa: BLE001
        return False

    global _said
    if not _said:
        _said = True
        print(
            "talaria: frosting " + ("on" if ok else "unavailable — panels will be plain"),
            file=sys.stderr, flush=True,
        )
    return ok
