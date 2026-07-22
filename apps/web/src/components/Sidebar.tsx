import {
  CalendarDays,
  Layers,
  Library,
  LogOut,
  MoreVertical,
  Pin,
  PinOff,
  Settings,
  Shapes,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
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
const TODAY_KEY = "today_colors";
const ALLBLOCKS_KEY = "allblocks_colors";
const COLLECTIONS_KEY = "collections_colors";

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
  const { colors, setPref } = usePreferences();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [modal, setModal] = useState<{ key: string; target: Target } | null>(null);
  const {
    active: hovered,
    setActive: setHovered,
    onMouseEnter: armOpen,
    onMouseLeave: collapse,
    cancelOpen,
  } = useHoverIntent();

  // The rail expands when pinned, when hovering an empty area, or while a
  // kebab menu / color modal it spawned is open.
  const expanded = leftPinned || hovered || openMenu !== null || modal !== null;

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

  const colorRow = (
    key: string,
    to: string,
    end: boolean,
    Icon: LucideIcon,
    label: string,
  ) => {
    const c = colors(key);
    const rowStyle: CSSProperties = {};
    if (c.bg) rowStyle.background = c.bg;
    if (c.text) rowStyle.color = c.text;
    return (
      <div className="nav-row" style={rowStyle}>
        <NavLink to={to} end={end} className="nav-link" title={label}>
          <Icon size={18} className="nav-row-icon" style={c.icon ? { color: c.icon } : undefined} />
          <span className="label">{label}</span>
        </NavLink>
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

      {colorRow(TODAY_KEY, "/today", false, CalendarDays, "Today")}
      {colorRow(ALLBLOCKS_KEY, "/blocks", false, Layers, "All blocks")}
      {colorRow(COLLECTIONS_KEY, "/collections", false, Library, "Collections")}

      <div className="spacer" onMouseEnter={armOpen} onMouseLeave={cancelOpen} />

      <div className="nav-divider" />
      <NavLink to="/types" className="nav-link" title="Block types">
        <Shapes size={18} />
        <span className="label">Types</span>
      </NavLink>
      <NavLink to="/settings" className="nav-link" title="Settings">
        <Settings size={18} />
        <span className="label">Settings</span>
      </NavLink>
      <button className="nav-link signout" onClick={() => void logout()} title="Sign out">
        <LogOut size={16} />
        <span className="label">Sign out</span>
      </button>

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
