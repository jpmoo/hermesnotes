/**
 * Send to Hermes — lasso a region, and it becomes a block.
 *
 * @format
 */

import { AppRegistry, Image } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { FileUtils, PluginCommAPI, PluginFileAPI, PluginManager } from 'sn-plugin-lib';
import { begin, set } from './src/session';
import { HermesFile } from './src/native';
import { READ, ensureAll, explain } from './src/permissions';

const LASSO_BUTTON = 1;
const NOTE_BUTTON = 2;

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

PluginManager.registerButton(2, ['NOTE'], {
  id: LASSO_BUTTON,
  name: 'Send selection',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  editDataTypes: [0, 1, 2, 3, 4, 5],
  /**
   * The view is shown, and it has to be — twice over.
   *
   * The obvious reason is that this plugin asks two questions before it sends
   * anything: what kind of thing this is, and what it is called.
   *
   * The reason that is not obvious, and cost somebody an afternoon on the last
   * plugin: Supernote only loads a plugin's native-module APK when a view is
   * instantiated. With `showType: 0` the JS runs and `NativeModules.HermesFile`
   * is undefined — which surfaces as a TypeError several frames from the cause.
   */
  showType: 1,
});

/*
 * The second surface: the whole note rather than a piece of it.
 *
 * A type-1 button lives on the note's own toolbar, so it is reachable without
 * selecting anything. One plugin carries both because both want the same
 * pairing, the same key, the same settings and the same native module — two
 * plugins would mean pairing twice and two copies of this client drifting
 * apart, which is exactly how the other two plugins came to need the same fix
 * on the same afternoon.
 */
PluginManager.registerButton(1, ['NOTE'], {
  id: NOTE_BUTTON,
  name: 'Send whole note',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: 1,
});

/**
 * The capture runs here, in the listener, and not in the view.
 *
 * `closePluginView` hides the view without unmounting the component, so the
 * next press reuses the same instance and a `useEffect` never runs again. The
 * listener does fire fresh every time, so it is the only place that reliably
 * knows a press happened. The view is told through `src/session`.
 */
PluginManager.registerButtonListener({
  onButtonPress: (event) => {
    if (!event) return;
    const whole = event.id === NOTE_BUTTON;
    if (!whole && event.id !== LASSO_BUTTON) return;
    begin(whole ? 'note' : 'selection');
    // The selection is read out of the note, which lives in shared storage and
    // is gated. What this writes — the sticker and the PNG — goes in the
    // plugin's own directory, which is exempt from permissions entirely, so
    // there is nothing to ask about that. Asked here, where a dialog arrives
    // immediately after a deliberate tap rather than out of nowhere at launch.
    ensureAll(READ)
      .then((verdict) => {
        // A refusal and a failure to ask read differently on screen, because
        // they are different problems. See `src/permissions.ts`.
        if (!verdict.ok) throw new Error(explain(verdict, 'reading the note'));
        return whole ? captureNote() : capture();
      })
      .then((got) => set({ working: false, png: got.png, noteName: got.noteName, pages: got.pages }))
      .catch((err) => {
        set({
          working: false,
          trouble: err instanceof Error ? err.message : String(err),
        });
      });
  },
});

function unwrap(value, what) {
  if (!value || !value.success) {
    const msg = (value && value.error && value.error.message) || `${what} failed`;
    throw new Error(msg);
  }
  return value.result;
}

function deriveBaseName(notePath) {
  const last = notePath.split('/').pop() || 'note';
  return last.replace(/\.[^.]+$/, '');
}

/**
 * The lasso selection, as a PNG in the plugin's own directory.
 *
 * A *sticker* rather than a page render, because a sticker holds only the
 * selected ink — no template ruling, no page background — which is what makes
 * the thing that arrives in Hermes look like what was drawn round rather than
 * like a photograph of part of a page.
 *
 * Written into the plugin directory and not EXPORT: this is a temporary on the
 * way to a block, and putting it in the folder somebody syncs would leave a
 * trail of half-sent PNGs behind every use.
 */
async function capture() {
  const pluginDir = await PluginManager.getPluginDirPath();
  if (!pluginDir) throw new Error('cannot resolve the plugin directory');
  const root = String(pluginDir).replace(/\/+$/, '');

  await sweep(root);

  try {
    PluginCommAPI.clearElementCache();
  } catch {
    // Best effort — the SDK's own example does the same.
  }

  let noteName = 'Note';
  try {
    noteName = deriveBaseName(
      unwrap(await PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath'),
    );
  } catch {
    // A note with no resolvable path still has a selection worth sending.
  }

  const stamp = Date.now();
  const stickerPath = `${root}/selection-${stamp}.sticker`;
  const pngPath = `${root}/selection-${stamp}.png`;

  unwrap(await PluginCommAPI.saveStickerByLasso(stickerPath), 'saveStickerByLasso');
  if (!(await FileUtils.exists(stickerPath))) {
    throw new Error('nothing was selected');
  }

  const size = unwrap(await PluginCommAPI.getStickerSize(stickerPath), 'getStickerSize');
  if (!size || !size.width || !size.height) {
    throw new Error(`the selection has no size (${JSON.stringify(size)})`);
  }

  unwrap(
    await PluginCommAPI.generateStickerThumbnail(stickerPath, pngPath, size),
    'generateStickerThumbnail',
  );
  if (!(await FileUtils.exists(pngPath))) {
    throw new Error('the selection could not be drawn as a PNG');
  }

  try {
    await FileUtils.deleteFile(stickerPath);
  } catch {
    // The PNG is what matters; the sticker is scaffolding.
  }

  return { png: pngPath, noteName };
}

/**
 * Every page of the note, joined into one tall PNG.
 *
 * The SDK renders a page at a time and has nothing that joins them, so the
 * pages go to temporary files and the native module stitches them — the same
 * shape Scroll Export uses, because it is the shape the SDK leaves available.
 *
 * `type: 1` on `generateNotePng` means a white background rather than a
 * transparent one. A note is ink on paper; a transparent render of it looks
 * like an empty file in most things that open a PNG.
 */
async function captureNote() {
  const pluginDir = await PluginManager.getPluginDirPath();
  if (!pluginDir) throw new Error('cannot resolve the plugin directory');
  const root = String(pluginDir).replace(/\/+$/, '');

  await sweep(root);

  const notePath = unwrap(await PluginCommAPI.getCurrentFilePath(), 'getCurrentFilePath');
  const noteName = deriveBaseName(notePath);
  const pages = unwrap(
    await PluginFileAPI.getNoteTotalPageNum(notePath),
    'getNoteTotalPageNum',
  );
  if (!pages || pages < 1) throw new Error('that note has no pages');

  const stamp = Date.now();
  const rendered = [];
  for (let i = 0; i < pages; i += 1) {
    const at = `${root}/page-${stamp}-${String(i).padStart(3, '0')}.png`;
    unwrap(
      await PluginFileAPI.generateNotePng({
        notePath,
        page: i,
        times: 1,
        pngPath: at,
        type: 1,
      }),
      `generateNotePng(page ${i + 1})`,
    );
    if (!(await FileUtils.exists(at))) throw new Error(`page ${i + 1} could not be drawn`);
    rendered.push(at);
  }

  const pngPath = `${root}/note-${stamp}.png`;
  // One page needs no joining, and asking the stitcher to make a copy of a
  // single bitmap is work and memory for nothing.
  if (rendered.length === 1) {
    await FileUtils.copyFile(rendered[0], pngPath);
  } else {
    await HermesFile.stitchVertically(rendered, pngPath);
  }
  if (!(await FileUtils.exists(pngPath))) throw new Error('the pages could not be joined');

  for (const at of rendered) {
    try {
      await FileUtils.deleteFile(at);
    } catch {
      // The joined picture is what matters; the pages were scaffolding.
    }
  }
  return { png: pngPath, noteName, pages };
}

/** Anything left by a send that failed or was abandoned. */
async function sweep(root) {
  try {
    const existing = await FileUtils.listFiles(root);
    for (const entry of existing || []) {
      if (/^(selection|note|page)-[\d-]+\.(sticker|png)$/.test(entry)) {
        await FileUtils.deleteFile(`${root}/${entry}`);
      }
    }
  } catch {
    // Tidying is not the job. A stale file costs disk, not correctness.
  }
}
