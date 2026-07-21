import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Lets a routed page render content into the right panel (via a portal into
 * `slotEl`), flag that content exists, and pin the panel open.
 */
interface RightPanelApi {
  slotEl: HTMLElement | null;
  setSlotEl: (el: HTMLElement | null) => void;
  active: boolean; // pinned open
  setActive: (b: boolean) => void;
  title: string;
  setTitle: (t: string) => void;
  hasContent: boolean;
  setHasContent: (b: boolean) => void;
}

const Ctx = createContext<RightPanelApi | null>(null);

export function RightPanelProvider({ children }: { children: ReactNode }) {
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState(false);
  const [title, setTitle] = useState("");
  const [hasContent, setHasContent] = useState(false);
  const value = useMemo(
    () => ({ slotEl, setSlotEl, active, setActive, title, setTitle, hasContent, setHasContent }),
    [slotEl, active, title, hasContent],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRightPanel(): RightPanelApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useRightPanel must be used within RightPanelProvider");
  return c;
}
