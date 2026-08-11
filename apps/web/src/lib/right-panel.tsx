import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { dailyNotePeriod } from "@hermes/shared";
import type { FeedEvent } from "../api.ts";
import { blockBrief } from "./block-brief.ts";

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
  selectedPage: RailPage | null; // a rail page (All blocks / Collections / Favorites), if current
  selectedFeedEvent: FeedEvent | null; // a read-only calendar-feed event, if current
  selectFeedEvent: (ev: FeedEvent | null) => void; // show a feed event in the info panel
  selectBlock: (id: string, opts?: { collection?: boolean }) => void; // log an interaction (no route change)
  /**
   * Tapping a block's representation — a row, chip, card or canvas node. On a
   * phone that opens it as a full page: the info panel is an off-screen drawer
   * there, so merely selecting would look like nothing happened. On a desktop,
   * where the panel is visible beside the content, it just selects.
   */
  selectOrOpen: (id: string, opts?: { collection?: boolean }) => void;
  selectToday: (date: string, noteId: string) => void; // log the Today page for a date
  selectPage: (page: RailPage) => void; // log a rail page as the current location
  /** Log + open as a full page. `fresh` marks something just created, so the
   *  page it lands on can put the caret in its first field. */
  openBlock: (id: string, opts?: { collection?: boolean; fresh?: boolean }) => void;
  clearSelection: () => void;
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
  recents: RecentEntry[];
  /**
   * The block the current navigation came from, for the page being opened to
   * scroll to if it shows it (a member of the collection, a section of the day).
   * Bumped per navigation so landing twice on the same page still scrolls.
   */
  scrollTarget: { id: string; nonce: number } | null;
  /** Record where we're leaving from — for navigations made outside here. */
  rememberOrigin: () => void;

  // Bumped when the selected block changes out-of-band (e.g. matrix region
  // actions edited its tags/status); the info pane refetches on change.
  infoTick: number;
  refreshInfo: () => void;
}

export type RailPage = "blocks" | "collections" | "favorites" | "archive" | "review";

// A history entry. `today` marks a Today page (routes to /today/<date>; `id` is
// then the day's note, used for the info pane). `page` marks a rail page.
interface NavEntry {
  id: string;
  collection: boolean;
  today?: string;
  page?: RailPage;
}

export type RecentEntry =
  | { kind: "block"; id: string }
  | { kind: "collection"; id: string }
  | { kind: "today"; date: string }
  | { kind: "page"; page: RailPage };
const recentKey = (e: RecentEntry) =>
  e.kind === "today"
    ? `t:${e.date}`
    : e.kind === "page"
      ? `p:${e.page}`
      : `${e.kind === "collection" ? "c" : "b"}:${e.id}`;

const Ctx = createContext<PanelsApi | null>(null);
const readBool = (k: string, dflt = false) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? dflt : v === "1";
  } catch {
    return dflt;
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
  const [hasContent, setHasContent] = useState(false);
  const [leftPinned, setLeftRaw] = useState(() => readBool("hn.pin.left"));
  // New users start with the right (info) panel pinned open.
  const [rightPinned, setRightRaw] = useState(() => readBool("hn.pin.right", true));

  const [nav, setNav] = useState<{ stack: NavEntry[]; pos: number }>({ stack: [], pos: -1 });
  const [selectedFeedEvent, setSelectedFeedEvent] = useState<FeedEvent | null>(null);
  const [recents, setRecents] = useState<RecentEntry[]>(() => readRecents("hn.recents"));
  const [scrollTarget, setScrollTarget] = useState<{ id: string; nonce: number } | null>(null);
  const scrollNonce = useRef(0);
  const [infoTick, setInfoTick] = useState(0);
  const refreshInfo = () => setInfoTick((t) => t + 1);

  const navigate = useNavigate();
  const pathRef = useRef("");
  pathRef.current = useLocation().pathname;

  /** The full page an entity lives at. History nav always opens entries here. */
  const pageOf = (entry: NavEntry) =>
    entry.page
      ? `/${entry.page}`
      : entry.today
        ? `/today/${entry.today}`
        : entry.collection
          ? `/collections/${entry.id}`
          : `/block/${entry.id}`;

  const sameEntity = (a: NavEntry, b: NavEntry) =>
    a.page || b.page
      ? a.page === b.page
      : a.today || b.today
        ? a.today === b.today
        : a.id === b.id && a.collection === b.collection;

  const setLeftPinned = (b: boolean) => {
    setLeftRaw(b);
    localStorage.setItem("hn.pin.left", b ? "1" : "0");
  };
  const setRightPinned = (b: boolean) => {
    setRightRaw(b);
    localStorage.setItem("hn.pin.right", b ? "1" : "0");
  };

  const cur = nav.pos >= 0 && nav.pos < nav.stack.length ? nav.stack[nav.pos]! : null;
  const selectedBlockId = cur && !cur.page ? cur.id : null;
  const selectedIsCollection = cur?.collection ?? false;
  const selectedToday = cur?.today ?? null;
  const selectedPage = cur?.page ?? null;

  const saveRecents = (next: RecentEntry[]) => {
    try {
      localStorage.setItem("hn.recents", JSON.stringify(next));
    } catch {
      /* ignore */
    }
    return next;
  };
  const addRecent = (e: RecentEntry) =>
    setRecents((prev) => {
      const k = recentKey(e);
      return saveRecents([e, ...prev.filter((x) => recentKey(x) !== k)].slice(0, 10));
    });

  /**
   * A daily note's scratchpad is not a loose block: it's the day. It's reached by
   * date, wears the calendar glyph, and opening it should give the whole page —
   * calendar, sections and all — not one text box out of context.
   *
   * Which block is one of these isn't known at the point of selection (a card, a
   * chip, a URL all hand over an id and nothing else), so the entry is logged as
   * a block and rewritten here once the block itself says so. That keeps every
   * call site honest without teaching each one about periodic notes.
   */
  const adoptDaily = async (id: string) => {
    const date = dailyNotePeriod((await blockBrief(id)).properties);
    if (!date) return;
    setNav((n) => {
      const rewritten = n.stack.map((e) =>
        !e.page && !e.collection && !e.today && e.id === id ? { ...e, today: date } : e,
      );
      // Selecting the scratchpad while already on its own day appended a second
      // entry; now that both name the same day, one of them is just a step in the
      // history that goes nowhere.
      const stack: NavEntry[] = [];
      let pos = n.pos;
      rewritten.forEach((e, i) => {
        const prev = stack[stack.length - 1];
        if (prev && sameEntity(prev, e)) {
          if (i <= n.pos) pos -= 1;
          return;
        }
        stack.push(e);
      });
      return { stack, pos: Math.min(Math.max(pos, stack.length ? 0 : -1), stack.length - 1) };
    });
    setRecents((prev) => {
      const seen = new Set<string>();
      return saveRecents(
        prev
          .map((e): RecentEntry => (e.kind === "block" && e.id === id ? { kind: "today", date } : e))
          .filter((e) => {
            const k = recentKey(e);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          }),
      );
    });
    // Already looking at the bare scratchpad (opened from a chip, or by URL).
    if (pathRef.current === `/block/${id}`) navigate(`/today/${date}`, { replace: true });
  };

  // Log an entity as current: append to the history (dropping any forward
  // entries), unless it already is current.
  const append = (entry: NavEntry) => {
    setSelectedFeedEvent(null); // selecting an entity supersedes a feed event
    setNav((n) => {
      const curEntry = n.pos >= 0 ? n.stack[n.pos] : undefined;
      if (curEntry && sameEntity(curEntry, entry)) return n;
      const base = n.stack.slice(0, n.pos + 1);
      return { stack: [...base, entry], pos: base.length };
    });
    if (entry.page) addRecent({ kind: "page", page: entry.page });
    else if (entry.today) addRecent({ kind: "today", date: entry.today });
    else {
      addRecent({ kind: entry.collection ? "collection" : "block", id: entry.id });
      if (!entry.collection) void adoptDaily(entry.id);
    }
  };

  /**
   * Note where this navigation is leaving from, so the page we land on can put
   * that block back in front of you — the member you were reading in a list, the
   * section you were in on a day — rather than dropping you at the top.
   */
  const rememberOrigin = () => {
    setScrollTarget(cur && !cur.page ? { id: cur.id, nonce: ++scrollNonce.current } : null);
  };

  const selectBlock = (id: string, opts?: { collection?: boolean }) =>
    append({ id, collection: opts?.collection ?? false });
  const selectToday = (date: string, noteId: string) =>
    append({ id: noteId, collection: false, today: date });
  const selectPage = (page: RailPage) => append({ id: `page:${page}`, collection: false, page });
  const openBlock = (id: string, opts?: { collection?: boolean; fresh?: boolean }) => {
    const entry: NavEntry = { id, collection: opts?.collection ?? false };
    rememberOrigin();
    append(entry);
    navigate(pageOf(entry), opts?.fresh ? { state: { fresh: true } } : undefined);
  };
  const selectOrOpen = (id: string, opts?: { collection?: boolean }) => {
    // Matches useIsMobile's breakpoint; read at call time so a resize is honoured
    // without this context re-rendering every consumer.
    let phone = false;
    try {
      phone = window.matchMedia("(max-width: 720px)").matches;
    } catch {
      /* no matchMedia: treat as desktop */
    }
    return phone ? openBlock(id, opts) : selectBlock(id, opts);
  };
  const selectFeedEvent = (ev: FeedEvent | null) => setSelectedFeedEvent(ev);
  const clearSelection = () => {
    setSelectedFeedEvent(null);
    setNav({ stack: [], pos: -1 });
  };
  const back = () => {
    if (nav.pos > 0) {
      const target = nav.stack[nav.pos - 1]!;
      rememberOrigin();
      setNav((n) => (n.pos > 0 ? { ...n, pos: n.pos - 1 } : n));
      navigate(pageOf(target));
    }
  };
  const forward = () => {
    if (nav.pos < nav.stack.length - 1) {
      const target = nav.stack[nav.pos + 1]!;
      rememberOrigin();
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
      hasContent,
      setHasContent,
      leftPinned,
      setLeftPinned,
      rightPinned,
      setRightPinned,
      selectedBlockId,
      selectedIsCollection,
      selectedToday,
      selectedPage,
      selectedFeedEvent,
      selectFeedEvent,
      selectBlock,
      selectOrOpen,
      selectToday,
      selectPage,
      openBlock,
      clearSelection,
      back,
      forward,
      canBack: nav.pos > 0,
      canForward: nav.pos < nav.stack.length - 1,
      recents,
      scrollTarget,
      rememberOrigin,
      infoTick,
      refreshInfo,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slotEl, bottomSlotEl, hasContent, leftPinned, rightPinned, nav, selectedFeedEvent, recents, scrollTarget, infoTick],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePanels(): PanelsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePanels must be used within PanelsProvider");
  return c;
}
