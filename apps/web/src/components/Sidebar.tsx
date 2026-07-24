import {
  CalendarDays,
  Layers,
  Library,
  LogOut,
  Moon,
  MoreVertical,
  Pin,
  PinOff,
  Plus,
  Search,
  Star,
  Settings,
  Shapes,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { NavLink } from "react-router-dom";
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
  const { colors, setPref, theme, setTheme } = usePreferences();
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
    onMouseEnter: armOpen,
    onMouseLeave: collapse,
    cancelOpen,
  } = useHoverIntent();

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
    openBlock(b.id);
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

  return (
    <aside className={`sidebar${expanded ? " expanded" : ""}`} onMouseLeave={collapse}>
      <div className="sidebar-head">
        <div className="brand">
          <img
            className="logo"
            src={`${import.meta.env.BASE_URL}brand/HermesLogoSmall.png`}
            alt="Hermes Notes"
          />
          <span className="brand-name">Hermes Notes</span>
        </div>
        <button
          className="icon-btn panel-pin"
          title={leftPinned ? "Collapse sidebar" : "Expand sidebar"}
          onClick={() => (leftPinned ? unpin() : setLeftPinned(true))}
        >
          {leftPinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
      </div>

      {actionRow(
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
      )}
      {actionRow(SEARCH_KEY, Search, "Search", () => setSearchOpen(true))}
      <div className="nav-divider" />

      {colorRow(TODAY_KEY, "/today", false, CalendarDays, "Today")}
      <div className="nav-divider" />
      {colorRow(FAVORITES_KEY, "/favorites", false, Star, "Favorites")}
      <div className="nav-divider" />
      {colorRow(ALLBLOCKS_KEY, "/blocks", false, Layers, "All blocks")}
      {colorRow(COLLECTIONS_KEY, "/collections", false, Library, "Collections")}
      {colorRow(TYPES_KEY, "/types", false, Shapes, "Types")}

      {/* Utilities stay anchored at the very bottom, grouped together. */}
      <div className="spacer" onMouseEnter={armOpen} onMouseLeave={cancelOpen} />
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
