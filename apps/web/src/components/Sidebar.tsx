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
import { usePanels } from "../lib/right-panel.tsx";
import { usePreferences } from "../lib/preferences.tsx";
import { useHoverIntent } from "../lib/useHoverIntent.ts";
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
 * Left navigation. Auto-hides to a 56px icon rail. Hovering an empty area of the
 * rail reveals it (icons stay click-to-navigate with a tooltip); a pin keeps it
 * open. The Inbox and Collections rows each carry a kebab menu (when revealed)
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
  const {
    active: hovered,
    setActive: setHovered,
    arm,
    onMouseLeave: collapse,
    cancelOpen,
  } = useHoverIntent();

  // Hovering an icon usually means "I'm about to click it", so the rail waits
  // there; over the logo or the gaps between icons a hover almost always means
  // "open the rail", so it reveals quickly. Sliding off an icon into open space
  // overtakes the longer wait rather than serving it out.
  const RAIL_OPEN_OVER_ICON = 700;
  const RAIL_OPEN_OVER_GAP = 140;
  const onRailOver = (e: React.MouseEvent) => {
    if (hovered) return; // already open — nothing to arm
    const overIcon = !!(e.target as HTMLElement).closest(".nav-link, .nav-row, button");
    // The kind matters as much as the delay: arriving over the rail's own
    // background and then settling on an icon has to start the icon's wait,
    // or every approach to an icon crosses a gap first and comes in on the
    // quick one — which is why the dwell never seemed to happen.
    arm(overIcon ? RAIL_OPEN_OVER_ICON : RAIL_OPEN_OVER_GAP, overIcon ? "icon" : "gap");
  };

  // The rail expands when pinned, when hovering an empty area, or while a
  // kebab menu / color modal / create menu it spawned is open.
  const expanded =
    leftPinned || hovered || openMenu !== null || modal !== null || plusOpen || newCollection;

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
    setHovered(false);
    cancelOpen();
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
    // Anywhere on the rail asks for the rail. The handler used to sit on the
    // icon strip alone, which left the logo — decoration, and the whole top of
    // the collapsed rail — as a dead spot that swallowed the hover.
    <aside
      className={`sidebar${expanded ? " expanded" : ""}`}
      onMouseOver={onRailOver}
      onMouseLeave={collapse}
    >
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
