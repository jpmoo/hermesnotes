import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

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
  selectBlock: (id: string) => void; // new train (a card/on-screen block)
  pushBlock: (id: string) => void; // drill into a connection/mention
  clearSelection: () => void;
  back: () => void;
  forward: () => void;
  goOrigin: () => void;
  canBack: boolean;
  canForward: boolean;
  atOrigin: boolean;
  recents: string[];
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

  const [nav, setNav] = useState<{ stack: string[]; pos: number }>({ stack: [], pos: -1 });
  const [recents, setRecents] = useState<string[]>(() => readList("hn.recents"));

  const setLeftPinned = (b: boolean) => {
    setLeftRaw(b);
    localStorage.setItem("hn.pin.left", b ? "1" : "0");
  };
  const setRightPinned = (b: boolean) => {
    setRightRaw(b);
    localStorage.setItem("hn.pin.right", b ? "1" : "0");
  };

  const selectedBlockId = nav.pos >= 0 && nav.pos < nav.stack.length ? nav.stack[nav.pos]! : null;

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

  const selectBlock = (id: string) => {
    setNav((n) => (n.pos === 0 && n.stack[0] === id ? n : { stack: [id], pos: 0 }));
    addRecent(id);
  };
  const pushBlock = (id: string) => {
    setNav((n) => {
      if (n.pos < 0) return { stack: [id], pos: 0 };
      if (n.stack[n.pos] === id) return n;
      const base = n.stack.slice(0, n.pos + 1);
      return { stack: [...base, id], pos: base.length };
    });
    addRecent(id);
  };
  const clearSelection = () => setNav({ stack: [], pos: -1 });
  const back = () => setNav((n) => (n.pos > 0 ? { ...n, pos: n.pos - 1 } : n));
  const forward = () => setNav((n) => (n.pos < n.stack.length - 1 ? { ...n, pos: n.pos + 1 } : n));
  const goOrigin = () => setNav((n) => (n.pos > 0 ? { ...n, pos: 0 } : n));

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
