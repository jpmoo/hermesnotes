import { useEffect, useRef } from "react";
import { usePanels } from "./right-panel.tsx";

/**
 * Land where you left off. Walking back to a collection or a daily note from one
 * of the things it holds should put that thing in front of you again — arriving
 * at the top of a long list and hunting for your place is the whole complaint.
 *
 * Anything that represents a block on the page carries `data-block-id`; this
 * finds the one we came from and scrolls to it. Nothing matches (you came from
 * elsewhere, or from a block this page doesn't show) and the page just starts at
 * the top, which is also what it does when there's no origin at all.
 *
 * @param ready whether the page's own content has arrived — members and sections
 *              come in on their own fetches, so this hunts for a beat rather than
 *              giving up on the first frame.
 */
export function useOriginScroll(ready: boolean) {
  const { scrollTarget } = usePanels();
  const id = scrollTarget?.id ?? null;
  const nonce = scrollTarget?.nonce ?? 0;
  // An origin is somewhere you came FROM, once. It stays set until the next
  // navigation records one, so a page that stays mounted and merely changes
  // what it's showing — stepping from day to day on the Today sheet — kept
  // being handed the same one and kept hunting for it. Landing halfway down
  // today, on a card you opened from some other day, was that: the block was
  // in the day's lists, so it was found and centred.
  const consumed = useRef(0);

  useEffect(() => {
    if (!ready) return;
    // The scroll container survives the route change, so without this a new page
    // opens at the old page's offset.
    document.querySelector<HTMLElement>(".main")?.scrollTo({ top: 0 });
    if (!id || nonce === consumed.current) return;
    consumed.current = nonce;

    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Scrolling yourself means you've found your own place; stop chasing.
    const cancel = () => {
      stop = true;
    };
    window.addEventListener("wheel", cancel, { passive: true });
    window.addEventListener("touchmove", cancel, { passive: true });
    window.addEventListener("keydown", cancel);

    let tries = 0;
    const hunt = () => {
      if (stop) return;
      const sel = `[data-block-id="${CSS.escape(id)}"]`;
      const el = document.querySelector<HTMLElement>(sel);
      if (el) {
        stop = true;
        el.scrollIntoView({ block: "center" });
        // A silent jump reads as "the page loaded scrolled" — the flash says the
        // position is deliberate, and which row it's about.
        el.classList.add("origin-flash");
        setTimeout(() => el.classList.remove("origin-flash"), 1500);
        return;
      }
      if (++tries < 24) timer = setTimeout(hunt, 60);
    };
    timer = setTimeout(hunt, 0);

    return () => {
      stop = true;
      clearTimeout(timer);
      window.removeEventListener("wheel", cancel);
      window.removeEventListener("touchmove", cancel);
      window.removeEventListener("keydown", cancel);
    };
  }, [ready, id, nonce]);
}
