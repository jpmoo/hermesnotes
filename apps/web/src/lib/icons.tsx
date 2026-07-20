import {
  Bell,
  Bookmark,
  Calendar,
  CheckSquare,
  Clock,
  Coffee,
  FileText,
  Flag,
  Folder,
  Heart,
  Image,
  Inbox,
  Layers,
  LayoutGrid,
  Link,
  List,
  MapPin,
  Music,
  Package,
  Pencil,
  Star,
  Table,
  Tag,
  Target,
  Type,
  User,
  Video,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Curated Lucide icon set for block types (design doc §10 uses Lucide, kebab-case
 * keys). A curated map keeps the bundle small; can grow into a full lazy-loaded
 * picker later. Keys match design-doc seed defaults where applicable.
 */
export const ICON_SET: Record<string, LucideIcon> = {
  "check-square": CheckSquare,
  calendar: Calendar,
  table: Table,
  "layout-grid": LayoutGrid,
  list: List,
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
  image: Image,
  video: Video,
  music: Music,
  package: Package,
  pencil: Pencil,
  coffee: Coffee,
  inbox: Inbox,
};

export const ICON_KEYS = Object.keys(ICON_SET);

export function BlockIcon({
  iconKey,
  color,
  size = 18,
}: {
  iconKey: string | null | undefined;
  color?: string | null;
  size?: number;
}) {
  const Icon = (iconKey && ICON_SET[iconKey]) || FileText;
  return <Icon size={size} color={color ?? undefined} />;
}
