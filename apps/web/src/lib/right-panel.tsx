import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Shared panel state: the right panel's content slot (portal target) + metadata,
 * and the pin state for both side panels (persisted). Pinned panels stay open
 * and reflow the layout (see the app-shell grid classes).
 */
interface PanelsApi {
  slotEl: HTMLElement | null;
  setSlotEl: (el: HTMLElement | null) => void;
  title: string;
  setTitle: (t: string) => void;
  hasContent: boolean;
  setHasContent: (b: boolean) => void;
  selectedBlockId: string | null;
  setSelectedBlockId: (id: string | null) => void;
  leftPinned: boolean;
  setLeftPinned: (b: boolean) => void;
  rightPinned: boolean;
  setRightPinned: (b: boolean) => void;
}

const Ctx = createContext<PanelsApi | null>(null);
const read = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};

export function PanelsProvider({ children }: { children: ReactNode }) {
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const [title, setTitle] = useState("");
  const [hasContent, setHasContent] = useState(false);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [leftPinned, setLeftRaw] = useState(() => read("hn.pin.left"));
  const [rightPinned, setRightRaw] = useState(() => read("hn.pin.right"));

  const setLeftPinned = (b: boolean) => {
    setLeftRaw(b);
    localStorage.setItem("hn.pin.left", b ? "1" : "0");
  };
  const setRightPinned = (b: boolean) => {
    setRightRaw(b);
    localStorage.setItem("hn.pin.right", b ? "1" : "0");
  };

  const value = useMemo(
    () => ({
      slotEl,
      setSlotEl,
      title,
      setTitle,
      hasContent,
      setHasContent,
      selectedBlockId,
      setSelectedBlockId,
      leftPinned,
      setLeftPinned,
      rightPinned,
      setRightPinned,
    }),
    [slotEl, title, hasContent, selectedBlockId, leftPinned, rightPinned],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePanels(): PanelsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePanels must be used within PanelsProvider");
  return c;
}
