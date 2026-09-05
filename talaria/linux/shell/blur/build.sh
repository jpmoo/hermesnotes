#!/usr/bin/env bash
# Build the blur binding.
#
# One `g++` invocation and a `wayland-scanner` run — no build system, because
# there is one source file and adding CMake to it would be more machinery than
# the thing it builds.
#
# Needs: g++, qt6-base-dev, libwayland-dev, libwayland-bin. These are build-time
# only; the result is a single `.so` that `ctypes` loads, and the development
# packages can be removed afterwards without breaking it.
set -euo pipefail
cd "$(dirname "$0")"

PROTOCOL=/usr/share/wayland-protocols/staging/ext-background-effect/ext-background-effect-v1.xml
[ -f "$PROTOCOL" ] || { echo "!! no $PROTOCOL — needs a wayland-protocols with ext-background-effect"; exit 1; }

# Regenerated rather than committed. The protocol belongs to Plasma and the
# generated code belongs to whichever version is installed here.
echo "==> Generating the protocol binding"
wayland-scanner client-header "$PROTOCOL" ext-background-effect-v1-client-protocol.h
wayland-scanner private-code  "$PROTOCOL" ext-background-effect-v1-protocol.c

# The protocol code is C and must be compiled as C.
#
# Handing the generated `.c` to `g++` compiles it as C++, which gives
# `ext_background_effect_manager_v1_interface` C++ linkage — while the generated
# header declares it inside `extern "C"`. The library then builds without a
# single error and fails to load with `undefined symbol`, which is a long way
# from where the mistake was.
echo "==> Compiling the protocol (as C)"
gcc -std=c11 -fPIC -O2 -c ext-background-effect-v1-protocol.c -o protocol.o \
  $(pkg-config --cflags wayland-client)

echo "==> Compiling"
g++ -std=c++17 -fPIC -shared -O2 \
  -o libtalaria_blur.so \
  talaria_blur.cpp protocol.o \
  $(pkg-config --cflags --libs Qt6Gui wayland-client) \
  -I"/usr/include/x86_64-linux-gnu/qt6/QtGui/$(pkg-config --modversion Qt6Gui)" \
  -Wall

echo "==> Built $(pwd)/libtalaria_blur.so"
nm -D --defined-only libtalaria_blur.so | grep talaria_blur | sed 's/^/    /'
