import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Shared panel state: the right panel's content slot, pin state, and the global
 * navigation model — one linear history of entities (notes, collections, Today
 * pages). Interacting with an entity logs it as current; the top-left nav
 * cluster walks the history, always opening entries as full pages.
 */
interface PanelsApi {
  slotEl: HTMLElement | null;
  setSlotEl: (el: HTMLElement | null) => void;
  bottomSlotEl: HTMLElement | null; // renders below the info pane
  setBottomSlotEl: (el: HTMLElement | null) => void;
  title: string;
  setTitle: (t: string) => void;
  hasContent: boolean;
  setHasContent: (b: boolean) => void;
  leftPinned: boolean;
  setLeftPinned: (b: boolean) => void;
  rightPinned: boolean;
  setRightPinned: (b: boolean) => void;

  // Global entity navigation.
  selectedBlockId: string | null;
  selectedIsCollection: boolean;
  selectedToday: string | null; // the Today-page date this selection represents, if any
  selectBlock: (id: string, opts?: { collection?: boolean }) => void; // log an interaction (no route change)
  selectToday: (date: string, noteId: string) => void; // log the Today page for a date
  openBlock: (id: string, opts?: { collection?: boolean }) => void; // log + open as a full page
  clearSelection: () => void;
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
  recents: RecentEntry[];
}

// A history entry. `today` marks a Today page (routes to /today/<date>); `id` is
// then the day's note, used for the info pane.
interface NavEntry {
  id: string;
  collection: boolean;
  today?: string;
}

export type RecentEntry =
  | { kind: "block"; id: string }
  | { kind: "collection"; id: string }
  | { kind: "today"; date: string };
const recentKey = (e: RecentEntry) =>
  e.kind === "today" ? `t:${e.date}` : `${e.kind === "collection" ? "c" : "b"}:${e.id}`;

const Ctx = createContext<PanelsApi | null>(null);
const readBool = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const readRecents = (k: string): RecentEntry[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(k) || "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    // Migrate the old string[] (block ids) form.
    return raw
      .map((x): RecentEntry | null =>
        typeof x === "string"
          ? { kind: "block", id: x }
          : x && typeof x === "object" && "kind" in x
            ? (x as RecentEntry)
            : null,
      )
      .filter((x): x is RecentEntry => x !== null);
  } catch {
    return [];
  }
};

export function PanelsProvider({ children }: { children: ReactNode }) {
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const [bottomSlotEl, setBottomSlotEl] = useState<HTMLElement | null>(null);
  const [title, setTitle] = useState("");
  const [hasContent, setHasContent] = useState(false);
  const [leftPinned, setLeftRaw] = useState(() => readBool("hn.pin.left"));
  const [rightPinned, setRightRaw] = useState(() => readBool("hn.pin.right"));

  const [nav, setNav] = useState<{ stack: NavEntry[]; pos: number }>({ stack: [], pos: -1 });
  const [recents, setRecents] = useState<RecentEntry[]>(() => readRecents("hn.recents"));

  const navigate = useNavigate();
  const pathRef = useRef("");
  pathRef.current = useLocation().pathname;

  /** The full page an entity lives at. History nav always opens entries here. */
  const pageOf = (entry: NavEntry) =>
    entry.today ? `/today/${entry.today}` : entry.collection ? `/collections/${entry.id}` : `/block/${entry.id}`;

  const sameEntity = (a: NavEntry, b: NavEntry) =>
    a.today || b.today ? a.today === b.today : a.id === b.id && a.collection === b.collection;

  const setLeftPinned = (b: boolean) => {
    setLeftRaw(b);
    localStorage.setItem("hn.pin.left", b ? "1" : "0");
  };
  const setRightPinned = (b: boolean) => {
    setRightRaw(b);
    localStorage.setItem("hn.pin.right", b ? "1" : "0");
  };

  const cur = nav.pos >= 0 && nav.pos < nav.stack.length ? nav.stack[nav.pos]! : null;
  const selectedBlockId = cur?.id ?? null;
  const selectedIsCollection = cur?.collection ?? false;
  const selectedToday = cur?.today ?? null;

  const addRecent = (e: RecentEntry) =>
    setRecents((prev) => {
      const k = recentKey(e);
      const next = [e, ...prev.filter((x) => recentKey(x) !== k)].slice(0, 10);
      try {
        localStorage.setItem("hn.recents", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  // Log an entity as current: append to the history (dropping any forward
  // entries), unless it already is current.
  const append = (entry: NavEntry) => {
    setNav((n) => {
      const curEntry = n.pos >= 0 ? n.stack[n.pos] : undefined;
      if (curEntry && sameEntity(curEntry, entry)) return n;
      const base = n.stack.slice(0, n.pos + 1);
      return { stack: [...base, entry], pos: base.length };
    });
    if (entry.today) addRecent({ kind: "today", date: entry.today });
    else addRecent({ kind: entry.collection ? "collection" : "block", id: entry.id });
  };

  const selectBlock = (id: string, opts?: { collection?: boolean }) =>
    append({ id, collection: opts?.collection ?? false });
  const selectToday = (date: string, noteId: string) =>
    append({ id: noteId, collection: false, today: date });
  const openBlock = (id: string, opts?: { collection?: boolean }) => {
    const entry: NavEntry = { id, collection: opts?.collection ?? false };
    append(entry);
    navigate(pageOf(entry));
  };
  const clearSelection = () => setNav({ stack: [], pos: -1 });
  const back = () => {
    if (nav.pos > 0) {
      const target = nav.stack[nav.pos - 1]!;
      setNav((n) => (n.pos > 0 ? { ...n, pos: n.pos - 1 } : n));
      navigate(pageOf(target));
    }
  };
  const forward = () => {
    if (nav.pos < nav.stack.length - 1) {
      const target = nav.stack[nav.pos + 1]!;
      setNav((n) => (n.pos < n.stack.length - 1 ? { ...n, pos: n.pos + 1 } : n));
      navigate(pageOf(target));
    }
  };

  const value = useMemo<PanelsApi>(
    () => ({
      slotEl,
      setSlotEl,
      bottomSlotEl,
      setBottomSlotEl,
      title,
      setTitle,
      hasContent,
      setHasContent,
      leftPinned,
      setLeftPinned,
      rightPinned,
      setRightPinned,
      selectedBlockId,
      selectedIsCollection,
      selectedToday,
      selectBlock,
      selectToday,
      openBlock,
      clearSelection,
      back,
      forward,
      canBack: nav.pos > 0,
      canForward: nav.pos < nav.stack.length - 1,
      recents,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slotEl, bottomSlotEl, title, hasContent, leftPinned, rightPinned, nav, recents],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePanels(): PanelsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePanels must be used within PanelsProvider");
  return c;
}
