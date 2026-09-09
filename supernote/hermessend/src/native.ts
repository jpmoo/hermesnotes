import { NativeModules } from "react-native";

/**
 * The three things the SDK cannot do. See `HermesFileModule.kt`.
 *
 * Checked rather than assumed: a missing native module shows up as `undefined`
 * at the first call site, several frames from the cause, and the cause is
 * always the same one — the plugin's view was never instantiated, so Supernote
 * never loaded the APK the module lives in. Saying that outright saves the
 * afternoon it costs to work out from a TypeError.
 */
interface HermesFileSpec {
  read(path: string): Promise<{ base64: string; sha256: string; size: number }>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<boolean>;
  /** Every page, one above the next, as one tall PNG. Answers the out path. */
  stitchVertically(paths: string[], outPath: string): Promise<string>;
}

const missing = () => {
  throw new Error(
    "the HermesFile native module is not loaded — the plugin button must use showType: 1, " +
      "because Supernote only loads a plugin's native code when its view is instantiated",
  );
};

export const HermesFile: HermesFileSpec =
  (NativeModules.HermesFile as HermesFileSpec | undefined) ?? {
    read: missing,
    readText: missing,
    writeText: missing,
    stitchVertically: missing,
  };
