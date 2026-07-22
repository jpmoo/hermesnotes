import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/**
 * Shared panel state: the right panel's content slot, pin state, and the block
 * info-pane navigation model — a history stack (back/forward), an origin (the
 * on-screen block you started from), and a system-wide recents list.
 */
interface PanelsApi {
  slotEl: HTMLElement | null;
  setSlotEl: (el: HTMLElement | null) => void;
  title: string;
  setTitle: (t: string) => void;
  hasContent: boolean;
  setHasContent: (b: boolean) => void;
  leftPinned: boolean;
  setLeftPinned: (b: boolean) => void;
  rightPinned: boolean;
  setRightPinned: (b: boolean) => void;

  // Block info navigation.
  selectedBlockId: string | null;
  selectedIsCollection: boolean;
  selectBlock: (id: string, opts?: { collection?: boolean }) => void; // new train (a card/on-screen block)
  pushBlock: (id: string, opts?: { collection?: boolean }) => void; // drill into a connection/mention
  clearSelection: () => void;
  back: () => void;
  forward: () => void;
  goOrigin: () => void;
  canBack: boolean;
  canForward: boolean;
  atOrigin: boolean;
  recents: string[];
}

interface NavEntry {
  id: string;
  collection: boolean;
}

const Ctx = createContext<PanelsApi | null>(null);
const readBool = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const readList = (k: string): string[] => {
  try {
    return JSON.parse(localStorage.getItem(k) || "[]") as string[];
  } catch {
    return [];
  }
};

export function PanelsProvider({ children }: { children: ReactNode }) {
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const [title, setTitle] = useState("");
  const [hasContent, setHasContent] = useState(false);
  const [leftPinned, setLeftRaw] = useState(() => readBool("hn.pin.left"));
  const [rightPinned, setRightRaw] = useState(() => readBool("hn.pin.right"));

  const [nav, setNav] = useState<{ stack: NavEntry[]; pos: number }>({ stack: [], pos: -1 });
  const [recents, setRecents] = useState<string[]>(() => readList("hn.recents"));

  const navigate = useNavigate();
  const pathRef = useRef("");
  pathRef.current = useLocation().pathname;

  // Sync the main view to a history entry. Collections open their page; a block
  // takes over the main view only when we're already on a detail page — so a
  // block drilled from a list stays in the pane, but going back from a
  // collection lands on the note's full page.
  const routeTo = (entry: NavEntry | undefined) => {
    if (!entry) return;
    if (entry.collection) {
      navigate(`/collections/${entry.id}`);
    } else if (pathRef.current.startsWith("/collections/") || pathRef.current.startsWith("/block/")) {
      navigate(`/block/${entry.id}`);
    }
  };

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

  const addRecent = (id: string) =>
    setRecents((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, 10);
      try {
        localStorage.setItem("hn.recents", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });

  const selectBlock = (id: string, opts?: { collection?: boolean }) => {
    const collection = opts?.collection ?? false;
    setNav((n) => (n.pos === 0 && n.stack[0]?.id === id ? n : { stack: [{ id, collection }], pos: 0 }));
    // Recents are recently-viewed blocks; collections have their own nav.
    if (!collection) addRecent(id);
  };
  const pushBlock = (id: string, opts?: { collection?: boolean }) => {
    const entry: NavEntry = { id, collection: opts?.collection ?? false };
    setNav((n) => {
      if (n.pos < 0) return { stack: [entry], pos: 0 };
      if (n.stack[n.pos]?.id === id) return n;
      const base = n.stack.slice(0, n.pos + 1);
      return { stack: [...base, entry], pos: base.length };
    });
    // Recents are recently-viewed blocks; collections have their own nav.
    if (!entry.collection) addRecent(id);
    routeTo(entry);
  };
  const clearSelection = () => setNav({ stack: [], pos: -1 });
  const back = () => {
    if (nav.pos > 0) {
      routeTo(nav.stack[nav.pos - 1]);
      setNav((n) => (n.pos > 0 ? { ...n, pos: n.pos - 1 } : n));
    }
  };
  const forward = () => {
    if (nav.pos < nav.stack.length - 1) {
      routeTo(nav.stack[nav.pos + 1]);
      setNav((n) => (n.pos < n.stack.length - 1 ? { ...n, pos: n.pos + 1 } : n));
    }
  };
  const goOrigin = () => {
    if (nav.pos > 0) {
      routeTo(nav.stack[0]);
      setNav((n) => (n.pos > 0 ? { ...n, pos: 0 } : n));
    }
  };

  const value = useMemo<PanelsApi>(
    () => ({
      slotEl,
      setSlotEl,
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
      selectBlock,
      pushBlock,
      clearSelection,
      back,
      forward,
      goOrigin,
      canBack: nav.pos > 0,
      canForward: nav.pos < nav.stack.length - 1,
      atOrigin: nav.pos <= 0,
      recents,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slotEl, title, hasContent, leftPinned, rightPinned, nav, recents],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePanels(): PanelsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePanels must be used within PanelsProvider");
  return c;
}
