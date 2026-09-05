import type { Condition, FilterGroup } from "@hermes/shared";

export const emptyGroup = (): FilterGroup => ({ kind: "group", match: "all", items: [] });

/** Loosely accept the group shape or the legacy {match, conditions[]} shape. */
export function normalizeFilter(value: unknown): FilterGroup {
  const v = value as { kind?: string; items?: unknown; match?: string; conditions?: unknown } | null;
  if (v && v.kind === "group" && Array.isArray(v.items)) return v as unknown as FilterGroup;
  if (v && Array.isArray(v.conditions)) {
    return {
      kind: "group",
      match: v.match === "any" ? "any" : "all",
      items: v.conditions as Condition[],
    };
  }
  return emptyGroup();
}
