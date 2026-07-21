import { Inbox, Library, LogOut, MoreVertical, Pin, PinOff, Settings, Shapes } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../api.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { usePanels } from "../lib/right-panel.tsx";
import { useHoverIntent } from "../lib/useHoverIntent.ts";
import { ColorPickerModal } from "./ColorPickerModal.tsx";

type Target = "bg" | "text" | "icon";
interface InboxColors {
  bg?: string;
  text?: string;
  icon?: string;
}

const PREF_KEY = "inbox_colors";
const LABELS: Record<Target, string> = {
  bg: "Change Background Color",
  text: "Change Text Color",
  icon: "Change Icon Color",
};

/**
 * Left navigation. Auto-hides to a 56px icon rail. Hovering an empty area of the
 * rail reveals it (icons stay click-to-navigate with a tooltip); a pin keeps it
 * open. The Inbox row carries a kebab menu (when revealed) to customize its
 * background / text / icon colors, which persist server-side and sync across
 * devices.
 */
export function Sidebar() {
  const { logout } = useAuth();
  const { leftPinned, setLeftPinned } = usePanels();
  const [menuOpen, setMenuOpen] = useState(false);
  const [colorTarget, setColorTarget] = useState<Target | null>(null);
  const [colors, setColors] = useState<InboxColors>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const {
    active: hovered,
    setActive: setHovered,
    onMouseEnter: armOpen,
    onMouseLeave: collapse,
    cancelOpen,
  } = useHoverIntent();

  // The rail expands when pinned, when hovering an empty area, or while a
  // menu/modal it spawned is open.
  const expanded = leftPinned || hovered || menuOpen || colorTarget !== null;

  // Load persisted Inbox colors from the server (synced across devices).
  useEffect(() => {
    let alive = true;
    void api
      .get<{ preferences: Record<string, unknown> }>("/settings/preferences")
      .then((res) => {
        if (alive) setColors((res.preferences?.[PREF_KEY] as InboxColors) ?? {});
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const applyColor = (target: Target, value: string) => {
    const next = { ...colors, [target]: value };
    setColors(next);
    void api.patch("/settings/preferences", { [PREF_KEY]: next }).catch(() => {});
  };

  const unpin = () => {
    setLeftPinned(false);
    setHovered(false);
    cancelOpen();
  };

  const inboxStyle: CSSProperties = {};
  if (colors.bg) inboxStyle.background = colors.bg;
  if (colors.text) inboxStyle.color = colors.text;

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

      <div className="nav-row" style={inboxStyle}>
        <NavLink to="/" end className="nav-link inbox-link" title="Inbox">
          <Inbox
            size={18}
            className="inbox-icon"
            style={colors.icon ? { color: colors.icon } : undefined}
          />
          <span className="label">Inbox</span>
        </NavLink>
        <div className="nav-kebab" ref={menuRef}>
          <button
            className="kebab-btn"
            title="Inbox options"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <div className="menu">
              {(["bg", "text", "icon"] as Target[]).map((t) => (
                <button
                  key={t}
                  className="menu-item"
                  onClick={() => {
                    setColorTarget(t);
                    setMenuOpen(false);
                  }}
                >
                  {LABELS[t]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <NavLink to="/collections" className="nav-link" title="Collections">
        <Library size={18} />
        <span className="label">Collections</span>
      </NavLink>

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
        open={colorTarget !== null}
        title={colorTarget ? LABELS[colorTarget] : ""}
        value={colorTarget ? colors[colorTarget] ?? "#5fa4b5" : "#5fa4b5"}
        onCancel={() => setColorTarget(null)}
        onSave={(c) => {
          if (colorTarget) applyColor(colorTarget, c);
          setColorTarget(null);
        }}
      />
    </aside>
  );
}
