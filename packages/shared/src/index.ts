export * from "./property-schema.js";
export * from "./collections.js";
export * from "./display.js";
export * from "./today.js";
export * from "./recurrence.js";

/** Icon metadata (doc §10). */
export interface IconSpec {
  icon_key: string | null;
  icon_color: string | null;
  icon_source: "lucide" | "custom";
  show_icon: boolean;
}

/** Default icon seeds for known v1 block types (doc §10), seeded per-user. */
export const DEFAULT_TYPE_ICONS: Record<string, string> = {
  task: "check-square",
  project: "clipboard",
  event: "calendar",
  table: "table",
  kanban: "kanban",
  canvas: "layout-grid",
  document: "file-text",
  list: "list",
  text: "type",
};
