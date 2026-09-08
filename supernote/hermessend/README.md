# Send to Hermes

A Supernote plugin. Lasso a region on a note, tap **Send to Hermes**, choose
whether it becomes a note or a task, give it a title — and it arrives in Hermes
Notes as a block with the selection attached as a PNG.

> Built with [Claude](https://claude.com/claude-code) and **not yet run on a
> device.** Everything here typechecks and every SDK call is checked against
> `sn-plugin-lib`'s own typings, which is not the same as working.

## How it works

1. A Type-2 (lasso toolbar) button, registered in `index.js`.
2. On press, the listener saves the selection as a Supernote *sticker*
   (`saveStickerByLasso`) — stickers hold only the selected ink, no template
   ruling — reads its natural size and re-encodes it as a PNG in the plugin's
   own directory.
3. The view opens showing that PNG, a note/task choice, and a title field.
4. Sending reads the PNG through this plugin's one native module, and writes
   the block through **pkm-interchange** — `PUT /api/interchange/objects/:id`,
   with the picture as an `attachment` value carrying `sha256` and base64
   `bytes`.

Nothing here touches Hermes' own routes. No `/blocks`, no
`/blocks/:id/attachments`, no Hermes-shaped payload — the plugin speaks the
format and nothing else, which is the standing rule for anything reaching
Hermes from outside.

## Two things about the Supernote SDK worth knowing

**`showType` must be `1`.** Supernote only loads a plugin's native-module APK
when a view is instantiated. With `showType: 0` the JS runs, the native module
is never registered, and `NativeModules.HermesFile` is `undefined` — which
surfaces as a TypeError several frames from the cause.

**Work belongs in the button listener, not in a `useEffect`.**
`closePluginView` hides the view without unmounting the component, so the next
press reuses the same instance and an effect never runs again. `src/session.ts`
is the channel between the listener and the view.

## Why there is a native module

`FileUtils` can tell you a file exists, list a directory, copy, rename, delete,
and take an MD5 — and has no way at all to put a file's contents in front of
JavaScript. There is no read, no base64, no stream, on any module in the SDK.

So `HermesFileModule.kt` does three things and no more: read a file as base64,
hash it with SHA-256, and keep a small settings file. The digest is native for
the same reason the read is — the format requires one beside any bytes an
attachment carries, and a pure-JS SHA-256 over a megabyte of PNG on this
hardware is slow enough to feel like a hang.

## Pairing

The device has no keyboard worth typing a forty-character token on, so it does
not have to.

1. Type your Hermes address once.
2. The plugin asks for a pairing code and shows six digits.
3. In Hermes Notes → Settings → Access keys, type those digits. It shows you
   what you are approving before you approve it.
4. The plugin, which has been polling, collects an ordinary access key — listed
   and revoked beside every other one.

The code is not the secret. The pairing id is, and only the device that asked
for it has that.

## Project layout

```
.
├── index.js                # button registration + lasso capture
├── App.tsx                 # pairing screen and send screen
├── src/
│   ├── hermes.ts           # the interchange client; types chosen by profile
│   ├── native.ts           # typed wrapper for the native module
│   ├── session.ts          # listener → view, since the view is never remounted
│   └── settings.ts         # base URL, token, cached types
├── PluginConfig.json       # plugin manifest
└── android/…/HermesFileModule.kt
```

## Build

Same as any Supernote plugin:

```bash
export JAVA_HOME=$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$(brew --prefix android-commandlinetools)/share/android-commandlinetools
export PATH="$JAVA_HOME/bin:$PATH"

npm install
./buildPlugin.sh
```

## SDK version, and why it matters more than it looks

Pinned to `sn-plugin-lib` **0.1.65**, not the `^0.1.43` the scaffold came with.

0.1.65 added a permission gate — `plugin.permission.FILE:WRITE`,
`FILE:DELETE` and `INTERNET` — and firmware that enforces it refuses plugins
built against the SDK before it, with a message about the plugin not working
with this version and needing an update. That reads like a broken plugin and is
not one: every plugin built against 0.1.43 stops installing at the same moment,
which is the tell.

`src/permissions.ts` asks for each at the point it is needed rather than three
dialogs at launch — file write and delete on the button press, network before
pairing and before sending — so the dialog arrives with its reason on screen. An
SDK with no permission API is treated as granting everything, so this does not
break itself on older firmware while being careful about newer.

Pinned rather than caret, because the version is a compatibility claim about
somebody's device and not a dependency to float.

## Known unfinished

- **Never run on a device.** See above.
- **The icon is Lasso Export's**, inherited from the scaffold this was forked
  from. It wants its own.
- **A type with no attachment field** is detected and said out loud before
  sending, but the block still goes without the picture. Whether that should be
  a refusal instead is a question for the first time it happens.
- **The types are cached from a whole-library read**, because the binding has no
  types-only narrowing. Fine for a dozen types and a few hundred notes; not
  fine forever.
