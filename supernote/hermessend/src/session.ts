/**
 * What the button captured, waiting for the view to pick it up.
 *
 * The two halves of this plugin cannot talk directly. `index.js` does the
 * capture inside the button listener — which is where it has to be, because
 * `closePluginView` hides the view without unmounting it, so a `useEffect` in
 * the component runs once and never again. The component is therefore reused
 * across presses and has to be *told*, not mounted.
 *
 * A module-level store with subscribers is the whole mechanism. Both halves are
 * in one JS bundle, so they share this module.
 */
export type Kind = "selection" | "note";

export interface Capture {
  /** Which button started this — a lasso selection, or the whole note. */
  kind: Kind;
  /** How many pages were joined, when it was the whole note. */
  pages?: number;
  /** Where the PNG of the selection is, once it exists. */
  png?: string;
  /** The note it came off, for a default title. */
  noteName?: string;
  /** Set while the sticker is being rendered. */
  working: boolean;
  /** Why there is no PNG, when there is not. */
  trouble?: string;
  /** Bumped per press, so the view knows this is a new one and resets. */
  seq: number;
}

let state: Capture = { kind: "selection", working: false, seq: 0 };
const watchers = new Set<(c: Capture) => void>();

export function current(): Capture {
  return state;
}

export function set(next: Partial<Capture>): void {
  state = { ...state, ...next };
  for (const w of watchers) w(state);
}

/** A fresh press: everything from the last one goes. */
export function begin(kind: Kind = "selection"): void {
  state = { kind, working: true, seq: state.seq + 1 };
  for (const w of watchers) w(state);
}

export function watch(fn: (c: Capture) => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}
