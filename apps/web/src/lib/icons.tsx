import {
  CalendarDays,
  Bell,
  Bookmark,
  Calendar,
  CheckSquare,
  Clock,
  FileSearch,
  FileText,
  Flag,
  ListFilter,
  ListTree,
  Folder,
  Grid3x3,
  Heart,
  Inbox,
  Layers,
  LayoutGrid,
  Link,
  List,
  MapPin,
  Package,
  Pencil,
  Star,
  Table,
  Tag,
  Target,
  Type,
  User,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useReducer } from "react";

/**
 * Icon rendering. A tiny curated set is statically imported for instant common
 * rendering; the full Lucide set (~1500) is lazy-loaded only when a custom icon
 * or the picker actually needs it (via ./all-icons), keeping the main bundle lean.
 * Stored keys are kebab-case (design doc §10); the full map is PascalCase-keyed.
 */

const CURATED: Record<string, LucideIcon> = {
  "check-square": CheckSquare,
  calendar: Calendar,
  "calendar-days": CalendarDays,
  table: Table,
  "layout-grid": LayoutGrid,
  "grid-3x3": Grid3x3,
  list: List,
  "list-tree": ListTree,
  "file-text": FileText,
  type: Type,
  tag: Tag,
  star: Star,
  flag: Flag,
  target: Target,
  bell: Bell,
  clock: Clock,
  bookmark: Bookmark,
  folder: Folder,
  layers: Layers,
  link: Link,
  "map-pin": MapPin,
  user: User,
  heart: Heart,
  zap: Zap,
  package: Package,
  pencil: Pencil,
  inbox: Inbox,
};

export function kebabToPascal(kebab: string): string {
  return kebab
    .split("-")
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : ""))
    .join("");
}
export function pascalToKebab(name: string): string {
  return name
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

// ── lazy full-set cache ─────────────────────────────────────────
type IconMap = Record<string, LucideIcon>;
let fullIcons: IconMap | null = null;
let loadPromise: Promise<IconMap> | null = null;
const subscribers = new Set<() => void>();

export function loadAllIcons(): Promise<IconMap> {
  if (fullIcons) return Promise.resolve(fullIcons);
  loadPromise ??= import("./all-icons.ts").then((m) => {
    fullIcons = m.icons as unknown as IconMap;
    subscribers.forEach((f) => f());
    return fullIcons;
  });
  return loadPromise;
}

/** Full icon map once loaded (null until then). Loads only when `enabled`. */
export function useAllIcons(enabled = true): IconMap | null {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!enabled || fullIcons) return;
    subscribers.add(force);
    void loadAllIcons();
    return () => void subscribers.delete(force);
  }, [enabled]);
  return fullIcons;
}

export function resolveIcon(iconKey: string | null | undefined): LucideIcon {
  if (!iconKey) return FileText;
  return CURATED[iconKey] ?? fullIcons?.[kebabToPascal(iconKey)] ?? FileText;
}

export function BlockIcon({
  iconKey,
  color,
  size = 18,
}: {
  iconKey: string | null | undefined;
  color?: string | null;
  size?: number;
}) {
  // Only pull the full set if this icon isn't in the curated fast-path.
  useAllIcons(!(iconKey && CURATED[iconKey]));
  const Icon = resolveIcon(iconKey);
  return <Icon size={size} color={color ?? undefined} />;
}

/**
 * Collection icons come in visual families: lists (List / ListFilter for
 * smart), documents (FileText / FileSearch for smart), matrices (LayoutGrid),
 * and tables (Table).
 */
export function CollectionIcon({
  document = false,
  matrix = false,
  table = false,
  canvas = false,
  calendar = false,
  rollup = false,
  smart = false,
  size = 16,
  color,
}: {
  document?: boolean;
  matrix?: boolean;
  table?: boolean;
  canvas?: boolean;
  calendar?: boolean;
  rollup?: boolean;
  smart?: boolean;
  size?: number;
  color?: string | null;
}) {
  const Icon = rollup
    ? ListTree
    : calendar
    ? CalendarDays
    : canvas
    ? Workflow
    : matrix
    ? Grid3x3
    : table
      ? Table
      : document
        ? smart
          ? FileSearch
          : FileText
        : smart
          ? ListFilter
          : List;
  return <Icon size={size} color={color ?? undefined} />;
}
