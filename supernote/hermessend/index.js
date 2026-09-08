/**
 * Send to Hermes — lasso a region, and it becomes a block.
 *
 * @format
 */

import { AppRegistry, Image } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { FileUtils, PluginCommAPI, PluginManager } from 'sn-plugin-lib';
import { begin, set } from './src/session';
import { READ, ensureAll, explain } from './src/permissions';

const BUTTON_ID = 1;

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

PluginManager.registerButton(2, ['NOTE'], {
  id: BUTTON_ID,
  name: 'Send to Hermes',
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
    if (!event || event.id !== BUTTON_ID) return;
    begin();
    // The selection is read out of the note, which lives in shared storage and
    // is gated. What this writes — the sticker and the PNG — goes in the
    // plugin's own directory, which is exempt from permissions entirely, so
    // there is nothing to ask about that. Asked here, where a dialog arrives
    // immediately after a deliberate tap rather than out of nowhere at launch.
    ensureAll(READ)
      .then((verdict) => {
        // A refusal and a failure to ask read differently on screen, because
        // they are different problems. See `src/permissions.ts`.
        if (!verdict.ok) throw new Error(explain(verdict, 'saving the selection'));
        return capture();
      })
      .then((got) => set({ working: false, png: got.png, noteName: got.noteName }))
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

  // Anything left from a send that failed, or one somebody abandoned by
  // closing the view. The successful path deletes its own, so what is here is
  // by definition litter.
  try {
    const existing = await FileUtils.listFiles(root);
    for (const entry of existing || []) {
      if (/^selection-\d+\.(sticker|png)$/.test(entry)) {
        await FileUtils.deleteFile(`${root}/${entry}`);
      }
    }
  } catch {
    // Tidying is not the job. A stale file costs disk, not correctness.
  }

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
