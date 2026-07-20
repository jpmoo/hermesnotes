import { Inbox, LogOut, MoreVertical, Settings } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { ColorPickerModal } from "./ColorPickerModal.tsx";

type Target = "bg" | "text" | "icon";
interface InboxColors {
  bg?: string;
  text?: string;
  icon?: string;
}

const STORAGE = "hn.inbox.colors";
const LABELS: Record<Target, string> = {
  bg: "Change Background Color",
  text: "Change Text Color",
  icon: "Change Icon Color",
};

/**
 * Left navigation. Auto-hides to a 56px icon rail and reveals on hover (no
 * open/close button). The Inbox row carries a kebab menu (when revealed) to
 * customize its background / text / icon colors via a color-picker modal;
 * choices persist to localStorage.
 */
export function Sidebar() {
  const { user, logout } = useAuth();
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [colorTarget, setColorTarget] = useState<Target | null>(null);
  const [colors, setColors] = useState<InboxColors>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE) ?? "{}") as InboxColors;
    } catch {
      return {};
    }
  });
  const menuRef = useRef<HTMLDivElement>(null);

  // Stay expanded while a menu or modal spawned from here is open.
  const expanded = hovered || menuOpen || colorTarget !== null;

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
    localStorage.setItem(STORAGE, JSON.stringify(next));
  };

  const inboxStyle: CSSProperties = {};
  if (colors.bg) inboxStyle.background = colors.bg;
  if (colors.text) inboxStyle.color = colors.text;

  return (
    <aside
      className={`sidebar${expanded ? " expanded" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="sidebar-head">
        <div className="brand">
          <img
            className="logo"
            src={`${import.meta.env.BASE_URL}brand/HermesLogoSmall.png`}
            alt="Hermes Notes"
          />
          <span className="brand-name">Hermes Notes</span>
        </div>
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

      <NavLink to="/settings" className="nav-link" title="Settings">
        <Settings size={18} />
        <span className="label">Settings</span>
      </NavLink>

      <div className="spacer" />

      <div className="nav-link user-info" style={{ cursor: "default" }}>
        <span className="label">{user?.displayName ?? user?.email}</span>
      </div>
      <button className="nav-link signout" onClick={() => void logout()} title="Sign out">
        <LogOut size={16} />
        <span className="label">Sign out</span>
      </button>

      <ColorPickerModal
        open={colorTarget !== null}
        title={colorTarget ? LABELS[colorTarget] : ""}
        value={colorTarget ? colors[colorTarget] ?? "#5fa4b5" : "#5fa4b5"}
        onCancel={() => {
          setColorTarget(null);
          setHovered(false);
        }}
        onSave={(c) => {
          if (colorTarget) applyColor(colorTarget, c);
          setColorTarget(null);
          setHovered(false);
        }}
      />
    </aside>
  );
}
