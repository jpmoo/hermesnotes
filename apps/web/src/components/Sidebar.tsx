import {
  Archive,
  CalendarDays,
  Layers,
  Library,
  ListChecks,
  LogOut,
  Moon,
  MoreVertical,
  Pin,
  PinOff,
  Plus,
  Search,
  Star,
  Settings,
  FileType2,
  Shapes,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { normalizeRail, RAIL_LAYOUT_PREF_KEY, type RailButtonId } from "@hermes/shared";
import { api, type Block, type BlockType } from "../api.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { BlockIcon } from "../lib/icons.tsx";
import { CreateCollectionModal } from "./CreateCollectionModal.tsx";
import { SearchModal } from "./SearchModal.tsx";
import { classifyPress } from "../lib/press.ts";
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { ColorPickerModal } from "./ColorPickerModal.tsx";

type Target = "bg" | "text" | "icon";

const TARGETS: Target[] = ["bg", "text", "icon"];
const LABELS: Record<Target, string> = {
  bg: "Change Background Color",
  text: "Change Text Color",
  icon: "Change Icon Color",
};

// Preference keys (server-side, synced across devices) for each colorable row.
// The Unattached row keeps the legacy "inbox_colors" key so saved colors carry over.
const NEW_KEY = "newmenu_colors";
const SEARCH_KEY = "search_colors";
const TODAY_KEY = "today_colors";
const FAVORITES_KEY = "favorites_colors";
const ALLBLOCKS_KEY = "allblocks_colors";
const COLLECTIONS_KEY = "collections_colors";
const TYPES_KEY = "types_colors";
const TEMPLATES_KEY = "templates_colors";
const REVIEW_KEY = "review_colors";
const ARCHIVE_KEY = "archive_colors";

/**
 * Left navigation. Auto-hides to a 56px icon rail, which is fully usable shut —
 * the icons stay click-to-navigate with a tooltip. Pressing the rail's own empty
 * parts unfolds it; pressing it again, anywhere, folds it back; a pin keeps it
 * open regardless. The Inbox and Collections rows each carry a kebab menu (when revealed)
 * to customize their background / text / icon colors, which persist server-side
 * and sync across devices.
 */
export function Sidebar() {
  const { logout } = useAuth();
  const { leftPinned, setLeftPinned } = usePanels();
  const { colors, setPref, theme, setTheme, prefs } = usePreferences();
  // The weekly-review rail icon only appears once a review day is configured.
  const reviewConfigured =
    (prefs.weekly_review as { dueWeekday?: number | null } | undefined)?.dueWeekday != null;
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [modal, setModal] = useState<{ key: string; target: Target } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newCollection, setNewCollection] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [types, setTypes] = useState<BlockType[]>([]);
  const { openBlock } = usePanels();
  /**
   * Unfolded, because the rail was asked for.
   *
   * Only the rail opens the rail, and any press in it closes it again — so it's
   * a thing you open, use, and are done with, rather than something that keeps
   * happening to you. It used to reveal itself on a hover with a dwell timer,
   * which meant it appeared when you were on your way past and didn't when you
   * meant it, and the difference was measured in milliseconds nobody can feel.
   */
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const press = classifyPress(e.target);
      if (press.kind === "panel" && press.side === "left") {
        // Pinned is pinned: nothing here moves it.
        if (leftPinned) return;
        const onControl = !!(e.target as Element)?.closest?.(".nav-link, .nav-row, button, a, input");
        if (onControl) {
          // A button does its own thing, and the rail gets out of the way of
          // whatever that turns out to be.
          setOpened(false);
          return;
        }
        // The rail's own empty parts are its handle, both ways. Held open by a
        // kebab or the create menu rather than by this, it still has to answer
        // to a press on its background — otherwise "click the empty bit" works
        // or doesn't depending on what happens to be open inside it, which is
        // not a rule anybody could learn.
        setOpenMenu(null);
        setModal(null);
        setPlusOpen(false);
        setOpened((open) => !open);
        return;
      }
      // Everywhere else closes it. Only the rail opens the rail: a press on the
      // page is you getting on with something out there, and a panel that
      // unfolds because you clicked the far side of the window is a panel with
      // opinions about what you meant.
      setOpened(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // Re-read when the pin changes: a pinned rail answers to nothing but the pin.
  }, [leftPinned]);

  // The rail expands when pinned, when the page was pressed, or while a
  // kebab menu / color modal / create menu it spawned is open.
  const expanded =
    leftPinned || opened || openMenu !== null || modal !== null || plusOpen || newCollection;

  // Block types for the + menu, fetched on first open.
  useEffect(() => {
    if (!plusOpen || types.length) return;
    void api.get<BlockType[]>("/block-types").then(setTypes).catch(() => {});
  }, [plusOpen, types.length]);
  useEffect(() => {
    if (!plusOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".sidebar-plus")) setPlusOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [plusOpen]);

  const createBlock = async (t: BlockType) => {
    setPlusOpen(false);
    const b = await api.post<Block>("/blocks", { blockTypeId: t.id });
    openBlock(b.id, { fresh: true });
  };
  const orderedTypes = [...types].sort((a, b) =>
    a.isText === b.isText ? a.name.localeCompare(b.name) : a.isText ? -1 : 1,
  );

  useEffect(() => {
    if (openMenu === null) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".nav-kebab")) setOpenMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openMenu]);

  const applyColor = (key: string, target: Target, value: string) => {
    setPref(key, { ...colors(key), [target]: value });
  };

  const unpin = () => {
    setLeftPinned(false);
    setOpened(false);
  };

  const kebab = (key: string, label: string) => (
    <div className="nav-kebab">
      <button
        className="kebab-btn"
        title={`${label} options`}
        onClick={() => setOpenMenu((cur) => (cur === key ? null : key))}
      >
        <MoreVertical size={16} />
      </button>
      {openMenu === key && (
        <div className="menu">
          {TARGETS.map((t) => (
            <button
              key={t}
              className="menu-item"
              onClick={() => {
                setModal({ key, target: t });
                setOpenMenu(null);
              }}
            >
              {LABELS[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const rowStyleOf = (key: string): CSSProperties => {
    const c = colors(key);
    const rowStyle: CSSProperties = {};
    if (c.bg) rowStyle.background = c.bg;
    if (c.text) rowStyle.color = c.text;
    return rowStyle;
  };

  const colorRow = (
    key: string,
    to: string,
    end: boolean,
    Icon: LucideIcon,
    label: string,
  ) => {
    const c = colors(key);
    return (
      <div className="nav-row" style={rowStyleOf(key)}>
        <NavLink to={to} end={end} className="nav-link" title={label}>
          <Icon size={18} className="nav-row-icon" style={c.icon ? { color: c.icon } : undefined} />
          <span className="label">{label}</span>
        </NavLink>
        {kebab(key, label)}
      </div>
    );
  };

  /** A colorable rail row whose main control is a button (Search, New…). */
  const actionRow = (
    key: string,
    Icon: LucideIcon,
    label: string,
    onClick: () => void,
    extra?: React.ReactNode,
    extraClass = "",
  ) => {
    const c = colors(key);
    return (
      <div className={`nav-row${extraClass ? ` ${extraClass}` : ""}`} style={{ ...rowStyleOf(key), position: "relative" }}>
        <button className="nav-link" title={label} onClick={onClick}>
          <Icon size={18} className="nav-row-icon" style={c.icon ? { color: c.icon } : undefined} />
          <span className="label">{label}</span>
        </button>
        {kebab(key, label)}
        {extra}
      </div>
    );
  };

  /** One rail button by id — reuses the existing colorRow / actionRow helpers. */
  const renderButton = (id: RailButtonId): ReactNode => {
    switch (id) {
      case "new":
        return actionRow(
          NEW_KEY,
          Plus,
          "New…",
          () => setPlusOpen((o) => !o),
          plusOpen ? (
            <div className="menu" style={{ left: 8, right: "auto", top: "100%" }}>
              {orderedTypes.map((t) => (
                <button key={t.id} className="menu-item type-item" onClick={() => void createBlock(t)}>
                  <BlockIcon iconKey={t.isText ? "type" : t.iconKey} color={t.iconColor} size={16} />
                  <span style={{ textTransform: "capitalize" }}>{t.name}</span>
                </button>
              ))}
              <button
                className="menu-item"
                onClick={() => {
                  setPlusOpen(false);
                  setNewCollection(true);
                }}
              >
                Collection…
              </button>
            </div>
          ) : undefined,
          "sidebar-plus",
        );
      case "search":
        return actionRow(SEARCH_KEY, Search, "Search", () => setSearchOpen(true));
      case "today":
        return colorRow(TODAY_KEY, "/today", false, CalendarDays, "Today");
      case "favorites":
        return colorRow(FAVORITES_KEY, "/favorites", false, Star, "Favorites");
      case "blocks":
        return colorRow(ALLBLOCKS_KEY, "/blocks", false, Layers, "All blocks");
      case "collections":
        return colorRow(COLLECTIONS_KEY, "/collections", false, Library, "Collections");
      case "types":
        return colorRow(TYPES_KEY, "/types", false, Shapes, "Types");
      case "templates":
        return colorRow(TEMPLATES_KEY, "/templates", false, FileType2, "Templates");
      case "review":
        // Only appears once a review day is configured.
        return reviewConfigured ? colorRow(REVIEW_KEY, "/review", false, ListChecks, "Weekly Review") : null;
      case "archive":
        return colorRow(ARCHIVE_KEY, "/archive", false, Archive, "Archive");
    }
  };

  // Build the rail from the saved layout: skip hidden/unavailable buttons and
  // collapse leading or consecutive divider lines (e.g. when a gated button
  // between two lines is absent).
  const layout = normalizeRail(prefs[RAIL_LAYOUT_PREF_KEY]);
  const body: ReactNode[] = [];
  let lastWasLine = false;
  layout.forEach((item, i) => {
    if (item.kind === "line") {
      if (lastWasLine || body.length === 0) return;
      body.push(<div key={`i${i}`} className="nav-divider" />);
      lastWasLine = true;
      return;
    }
    if (item.kind === "flex") {
      body.push(<div key={`i${i}`} className="spacer" />);
      lastWasLine = false;
      return;
    }
    if (item.kind === "gap") {
      body.push(<div key={`i${i}`} className="rail-gap" />);
      lastWasLine = false;
      return;
    }
    if (item.hidden) return;
    const el = renderButton(item.id);
    if (!el) return;
    body.push(<Fragment key={`i${i}`}>{el}</Fragment>);
    lastWasLine = false;
  });

  return (
    <aside className={`sidebar${expanded ? " expanded" : ""}`}>
      <div className="sidebar-head">
        {/* The pin sits in the rail column, over the icons it belongs to. On the
            right-hand panel the same button lands over its own rail because the
            rail is on that side; here it was at the far end of the header, as
            far from the rail as the panel allows. */}
        <button
          className="icon-btn panel-pin"
          title={leftPinned ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => (leftPinned ? unpin() : setLeftPinned(true))}
        >
          {leftPinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        <div className="brand">
          <img
            className="logo"
            src={`${import.meta.env.BASE_URL}brand/HermesLogoSmall.png`}
            alt="Hermes Notes"
          />
          <span className="brand-name">Hermes Notes</span>
        </div>
      </div>

      {/* The customizable middle — buttons + dividers, in the user's order. */}
      <div className="rail-scroll">
        {body}
      </div>

      {/* Utilities stay anchored at the very bottom (fixed, not customizable). */}
      <div className="rail-bottom">
        <div className="nav-divider" />
        <button
          className="nav-link"
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          <span className="label">{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>
        <NavLink to="/settings" className="nav-link" title="Settings">
          <Settings size={18} />
          <span className="label">Settings</span>
        </NavLink>
        <button className="nav-link signout" onClick={() => void logout()} title="Sign out">
          <LogOut size={16} />
          <span className="label">Sign out</span>
        </button>
      </div>

      {newCollection && <CreateCollectionModal onClose={() => setNewCollection(false)} />}
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}

      <ColorPickerModal
        open={modal !== null}
        title={modal ? LABELS[modal.target] : ""}
        value={(modal ? colors(modal.key)[modal.target] : undefined) ?? "#5fa4b5"}
        onCancel={() => setModal(null)}
        onSave={(color) => {
          if (modal) applyColor(modal.key, modal.target, color);
          setModal(null);
        }}
      />
    </aside>
  );
}
