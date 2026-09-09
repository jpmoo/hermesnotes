/**
 * Send to Hermes — the view.
 *
 * Two screens in one component. Unpaired, it asks where Hermes is and walks
 * through pairing; paired, it shows what was lassoed and asks what to call it
 * and what it should be.
 *
 * The component is never unmounted between presses — `closePluginView` hides it
 * — so everything that must happen per press is driven by `src/session`
 * rather than by mounting. See the note in `index.js`.
 *
 * @format
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  TouchableOpacity,
  View,
} from 'react-native';
import { FileUtils, NativeUIUtils, PluginManager } from 'sn-plugin-lib';
import {
  Hermes,
  HermesError,
  attachmentKey,
  offer,
  titleKey,
  uuid,
  type HermesType,
} from './src/hermes';
import { HermesFile } from './src/native';
import { load, save, type Settings } from './src/settings';
import { current, watch, type Capture } from './src/session';
import { INTERNET, WRITE, ensure, explain } from './src/permissions';

type Kind = 'note' | 'task';

function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [capture, setCapture] = useState<Capture>(current());
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  // Pairing
  const [base, setBase] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  // Composing
  const [typeId, setTypeId] = useState('');
  const [title, setTitle] = useState('');
  const seen = useRef(-1);

  useEffect(() => {
    void load().then((s) => {
      setSettings(s);
      setBase(s.base);
      if (s.lastTypeId) setTypeId(s.lastTypeId);
    });
    return watch(setCapture);
  }, []);

  /*
   * A new press resets the form.
   *
   * Keyed on the sequence rather than on the PNG path, because two presses can
   * produce the same path in the same millisecond and, more importantly, a
   * press that *failed* has no path at all and still has to clear the last
   * one's title off the screen.
   */
  useEffect(() => {
    if (capture.seq === seen.current) return;
    seen.current = capture.seq;
    setTitle('');
    setTrouble(null);
  }, [capture.seq]);

  /*
   * No type picker at all.
   *
   * The kind is chosen by which button gets pressed, and which *type* of note
   * is resolved at send time from what declares the profile — see `send`. A
   * library with two kinds of task is a real thing, and choosing between them
   * on an e-ink screen before you have said what this is would be a question
   * asked at the wrong moment. First one wins, and the note can be retyped in
   * Hermes where that is a comfortable thing to do.
   */

  const stop = () => {
    if (polling.current) clearInterval(polling.current);
    polling.current = null;
  };
  useEffect(() => stop, []);

  /**
   * A way out, from every screen.
   *
   * There was none: the view closed itself only after a send succeeded, so a
   * pairing that failed, an address typed wrong, or simply changing your mind
   * left somebody holding a screen with no exit. On a device whose back gesture
   * belongs to the note underneath, a plugin without its own close button is a
   * plugin you have to reboot out of.
   *
   * Polling deliberately continues: closing the view is putting it down, not
   * cancelling the pairing, and the key should still land if the code is
   * approved a minute later on a laptop.
   */
  /**
   * Say it happened, and wait to be acknowledged.
   *
   * A toast is gone in three seconds and can be missed entirely on a screen
   * that redraws as slowly as this one — and the view deliberately stays open
   * afterwards so somebody can save *and* send, which makes "did that work?" a
   * question they will actually have. A dialog answers it.
   */
  const say = async (message: string) => {
    try {
      await NativeUIUtils.showRattaDialog(message, '', 'OK', true);
    } catch {
      // Older firmware, or a dialog the host declined to show. The work is
      // done either way, and a toast is better than silence.
      try {
        ToastAndroid.show(message, ToastAndroid.LONG);
      } catch {
        // Nothing left to try.
      }
    }
  };

  /**
   * A copy in EXPORT, where the device's own file browser can reach it.
   *
   * Through `FileUtils` rather than by writing the bytes again: the PNG already
   * exists in the plugin's directory, and going through the SDK is also what
   * puts the new file in Supernote's own index rather than leaving it invisible
   * until something rescans.
   */
  const saveToDevice = useCallback(async () => {
    if (!capture.png) return;
    setBusy(true);
    setTrouble(null);
    try {
      const allowed = await ensure(WRITE);
      if (!allowed.ok) {
        setTrouble(explain(allowed, 'saving to the device'));
        return;
      }
      const dir = await FileUtils.getExportPath();
      if (!dir) throw new Error('cannot find the EXPORT folder');
      await FileUtils.makeDir(dir);
      const base = (title.trim() || capture.noteName || 'note').replace(/[^A-Za-z0-9._ -]+/g, '_');
      const name = `${base}-${Date.now()}.png`;
      const to = `${String(dir).replace(/\/+$/, '')}/${name}`;
      const ok = await FileUtils.copyFile(capture.png, to);
      if (!ok) throw new Error('the file could not be written to EXPORT');
      await say(`Saved to EXPORT as ${name}.`);
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [capture, title]);

  const close = () => {
    try {
      PluginManager.closePluginView();
    } catch {
      // Nothing else to offer — but the button has to exist either way.
    }
  };

  /** Ask for a code, then wait to be approved. */
  const startPairing = useCallback(async () => {
    const where = base.trim();
    if (!where) return;
    setBusy(true);
    setTrouble(null);
    try {
      // Network access is a permission the host grants per plugin now. Asked
      // here rather than at launch, so the dialog arrives with a reason
      // visible on screen.
      //
      // Three answers, not two: a refusal and a failure to ask are different
      // things, and calling the second one a refusal sends somebody hunting
      // for a switch they never touched. See `src/permissions.ts`.
      const net = await ensure(INTERNET);
      if (!net.ok) {
        setTrouble(explain(net, 'pairing'));
        return;
      }
      const root = where.replace(/\/+$/, '').replace(/\/api$/, '');
      const res = await fetch(`${root}/api/auth/pair/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Supernote' }),
      });
      if (!res.ok) throw new Error(`${res.status} — is that the right address?`);
      const started = (await res.json()) as { deviceId: string; code: string };
      setCode(started.code);
      await save({ base: where, deviceId: started.deviceId });
      setSettings({ base: where, deviceId: started.deviceId });

      // Polled rather than pushed, because the device has nothing to be pushed
      // to. Two seconds is fast enough that pairing feels immediate and slow
      // enough that a forgotten screen is not a load on anything.
      stop();
      polling.current = setInterval(() => {
        void (async () => {
          try {
            const got = await fetch(`${root}/api/auth/pair/${started.deviceId}`);
            const answer = (await got.json()) as { status: string; token?: string };
            if (answer.status === 'paired' && answer.token) {
              stop();
              const next: Settings = { base: where, token: answer.token };
              await save(next);
              setSettings(next);
              setCode(null);
              void refreshTypes(next);
            } else if (answer.status === 'expired' || answer.status === 'unknown') {
              stop();
              setCode(null);
              setTrouble('that code expired — try again');
            }
          } catch {
            // The network came and went. The next tick will try again.
          }
        })();
      }, 2000);
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [base]);

  /** The types, cached — a whole library read, so not once per send. */
  const refreshTypes = useCallback(async (using?: Settings) => {
    const s = using ?? settings;
    if (!s?.token) return;
    try {
      const found = await new Hermes(s.base, s.token).types();
      const next = { ...s, types: found };
      await save(next);
      setSettings(next);
    } catch (err) {
      setTrouble(err instanceof HermesError ? err.message : 'could not read the types');
    }
  }, [settings]);

  /**
   * The file, as an interchange attachment value.
   *
   * Read and hashed by the native module, because the format wants a digest
   * beside any bytes and a JS SHA-256 over a megabyte of PNG on this hardware
   * feels like a hang.
   */
  const fileValue = useCallback(async (named: string) => {
    const got = await HermesFile.read(capture.png!);
    return {
      kind: 'attachment',
      filename: `${named.replace(/[^A-Za-z0-9._ -]+/g, '_')}.png`,
      mediaType: 'image/png',
      sha256: got.sha256,
      bytes: got.base64,
    };
  }, [capture.png]);

  /** Straight onto today's page, with no title to think of. */
  const sendToday = useCallback(async () => {
    if (!settings?.token || !capture.png) return;
    setBusy(true);
    setTrouble(null);
    try {
      const net = await ensure(INTERNET);
      if (!net.ok) {
        setTrouble(explain(net, 'sending'));
        return;
      }
      const hermes = new Hermes(settings.base, settings.token);
      const day = new Date().toLocaleDateString('en-CA');
      const page = await hermes.today(day);
      if (!page) {
        setTrouble('no type in your library declares the journal profile, so there is no page for today');
        return;
      }
      const slot = attachmentKey(page.type);
      if (!slot) {
        setTrouble(`${page.type.name} has no attachment field, so the picture has nowhere to go`);
        return;
      }
      const answer = await hermes.patch(page.id, {
        version: page.version,
        set: { [slot]: [await fileValue(capture.noteName || 'Note')] },
      });
      // A refusal is a refusal in whatever shape it arrives — a stale version
      // says so with `conflict`, not with a report about attachments.
      if (answer.ok === false) {
        setTrouble(
          answer.conflict
            ? "today's page changed while this was being sent — try again"
            : `Hermes refused it (${(answer.reports ?? []).join(', ') || 'no reason given'})`,
        );
        return;
      }
      const lost = (answer.reports ?? []).filter((r) => r.startsWith('attachment.'));
      await say(
        lost.length
          ? `Added to today's note, without the picture (${lost[0]}).`
          : "Added to today's daily note in Hermes.",
      );
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [settings, capture, fileValue]);

  const send = useCallback(async (as: Kind) => {
    const forKind = offer((settings?.types ?? []) as HermesType[])[as];
    const chosen = forKind.find((t) => t.id === typeId) ?? forKind[0];
    if (!settings?.token || !chosen || !capture.png) {
      if (!chosen) setTrouble(`no type in your library declares the ${as} profile`);
      return;
    }
    setBusy(true);
    setTrouble(null);
    try {
      const net = await ensure(INTERNET);
      if (!net.ok) {
        setTrouble(explain(net, 'sending'));
        return;
      }
      const hermes = new Hermes(settings.base, settings.token);

      const named = title.trim() || capture.noteName || 'Untitled';
      const slot = titleKey(chosen, as);
      const files = attachmentKey(chosen);

      const properties: Record<string, unknown> = {};
      if (slot) properties[slot] = named;
      if (files) properties[files] = [await fileValue(named)];

      const answer = await hermes.create(uuid(), {
        type: chosen.id,
        properties,
        // A text type keeps its words in the reserved body slot rather than in
        // a property. With nothing typed there is nothing to put there, and the
        // title carries the meaning.
        ...(slot ? {} : { content: named }),
      });

      // A create that could not keep the picture is not a failure and is not a
      // plain success either. Reports name what was reduced, and this is the
      // one place somebody will ever see them.
      const lost = (answer.reports ?? []).filter((r) => r.startsWith('attachment.'));
      await save({ ...settings, lastTypeId: chosen.id });
      setSettings({ ...settings, lastTypeId: chosen.id });
      /*
       * Said, and the view left open.
       *
       * Closing on success would be tidier and is wrong here: somebody may want
       * to save the picture to the device as well, or send it to today's page
       * too, and a view that vanishes the moment one of those succeeds makes
       * the second one a second lasso. Closing is a button, and it is theirs.
       */
      await say(
        lost.length
          ? `Made a new ${as} in Hermes, without the picture (${lost[0]}).`
          : `Made a new Hermes ${as}: “${named}”.`,
      );
    } catch (err) {
      setTrouble(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [settings, capture, title, typeId, fileValue]);

  if (!settings) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator />
      </View>
    );
  }

  // ── Not paired yet ────────────────────────────────────────────────────────
  if (!settings.token) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.page}>
        <Text style={styles.heading}>Connect to Hermes Notes</Text>
        {code ? (
          <>
            <Text style={styles.hint}>
              In Hermes Notes, open Settings and type this code under Access keys.
            </Text>
            <Text style={styles.code}>{code}</Text>
            <Text style={styles.hint}>Waiting for it to be approved…</Text>
          </>
        ) : (
          <>
            <Text style={styles.hint}>
              The address of your Hermes Notes. You only type this once.
            </Text>
            <TextInput
              style={styles.input}
              value={base}
              onChangeText={setBase}
              placeholder="https://notes.example.com"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={[styles.button, (!base.trim() || busy) && styles.buttonOff]}
              disabled={!base.trim() || busy}
              onPress={() => void startPairing()}
            >
              <Text style={styles.buttonText}>Get a pairing code</Text>
            </TouchableOpacity>
          </>
        )}
        {trouble ? <Text style={styles.trouble}>{trouble}</Text> : null}
        <TouchableOpacity style={styles.quiet} onPress={close}>
          <Text style={styles.quietText}>Close</Text>
        </TouchableOpacity>
        {code ? (
          <TouchableOpacity
            style={styles.quiet}
            onPress={() => {
              stop();
              setCode(null);
              setTrouble(null);
            }}
          >
            <Text style={styles.quietText}>Start over</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    );
  }

  // ── Paired: what did we just lasso? ───────────────────────────────────────
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.page}>
      {capture.working ? (
        <View style={styles.centre}>
          <ActivityIndicator />
          <Text style={styles.hint}>Reading the selection…</Text>
        </View>
      ) : capture.trouble ? (
        <Text style={styles.trouble}>{capture.trouble}</Text>
      ) : capture.png ? (
        <Image source={{ uri: `file://${capture.png}` }} style={styles.preview} resizeMode="contain" />
      ) : (
        <Text style={styles.hint}>Lasso something, then tap Send to Hermes.</Text>
      )}

      {/*
        The two things that need no title, above the field that asks for one.
        
        Sending to today's page and saving a copy to the device are both
        complete actions on their own — today's page is named after the day, and
        a file on disk is named after the note. The title field below belongs to
        the two buttons under it and to nothing else.
      */}
      <TouchableOpacity
        style={[styles.button, (busy || !capture.png) && styles.buttonOff]}
        disabled={busy || !capture.png}
        onPress={() => void sendToday()}
      >
        <Text style={styles.buttonText}>Add to today's daily note in Hermes</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, (busy || !capture.png) && styles.buttonOff]}
        disabled={busy || !capture.png}
        onPress={() => void saveToDevice()}
      >
        <Text style={styles.buttonText}>Save PNG to device</Text>
      </TouchableOpacity>

      <View style={styles.rule} />

      <TextInput
        style={styles.input}
        value={title}
        onChangeText={setTitle}
        placeholder={capture.noteName ? `Title (from ${capture.noteName})` : 'Title'}
      />

      <TouchableOpacity
        style={[styles.button, (busy || !capture.png) && styles.buttonOff]}
        disabled={busy || !capture.png}
        onPress={() => void send('note')}
      >
        <Text style={styles.buttonText}>New Hermes Note</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, (busy || !capture.png) && styles.buttonOff]}
        disabled={busy || !capture.png}
        onPress={() => void send('task')}
      >
        <Text style={styles.buttonText}>New Hermes Task</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.button, styles.buttonQuiet]} onPress={close}>
        <Text style={styles.buttonText}>Close</Text>
      </TouchableOpacity>

      {trouble ? <Text style={styles.trouble}>{trouble}</Text> : null}

    </ScrollView>
  );
}

/* E-ink: no color worth the name, high contrast, and generous targets for a
 * finger on a screen that redraws slowly. */
const styles = StyleSheet.create({
  /*
   * An opaque sheet, which has to be said out loud.
   *
   * A React Native view has no background unless one is given, and the host
   * composites the plugin over the note it was opened from — so every screen
   * here was a form floating on somebody's handwriting, with the page showing
   * through the buttons. Set on the ScrollView itself rather than on the
   * content container: the container is only as tall as what is in it, so a
   * background there leaves the empty space below the last control transparent,
   * which looks like a rendering fault rather than a short form.
   */
  screen: { flex: 1, backgroundColor: '#fff' },
  page: { padding: 20, gap: 14, flexGrow: 1 },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
    backgroundColor: '#fff',
  },
  heading: { fontSize: 20, fontWeight: '600', color: '#000' },
  hint: { fontSize: 14, color: '#444' },
  code: { fontSize: 44, fontWeight: '700', letterSpacing: 8, color: '#000', paddingVertical: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#000',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#000',
  },
  preview: {
    width: '100%',
    height: 240,
    borderWidth: 1,
    borderColor: '#bbb',
    borderRadius: 6,
    backgroundColor: '#fff',
  },
  kinds: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  kind: { borderWidth: 1, borderColor: '#000', borderRadius: 6, paddingHorizontal: 16, paddingVertical: 10 },
  kindOn: { backgroundColor: '#000' },
  kindText: { fontSize: 15, color: '#000' },
  kindTextOn: { color: '#fff' },
  button: {
    backgroundColor: '#000',
    borderRadius: 6,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonOff: { backgroundColor: '#999' },
  /* Closing is not the thing anybody came here to do, so it is the same shape
     as the rest and a lighter weight rather than a different kind of control. */
  buttonQuiet: { backgroundColor: '#555' },
  /* The two ways to make something new, side by side and equal. */
  pair: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  /* Between "today" and the naming below it: they are two answers to one
     question and the line says so without a word. */
  rule: { height: 1, backgroundColor: '#ddd', marginVertical: 4 },
  /* The way out. Plain rather than prominent — it is always available and
     never the thing somebody came here to do. */
  quiet: { paddingVertical: 12, alignItems: 'center' },
  quietText: { fontSize: 15, color: '#000', textDecorationLine: 'underline' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  trouble: { fontSize: 14, color: '#8a1c1c' },
});

export default App;
