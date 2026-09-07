/*
 * The filter builder, absent by decision rather than by omission.
 *
 * A Hermes canvas can be query-fed: matches of a saved filter sync in as placed
 * members. Talaria's canvas is `canvas.json` — a document somebody arranged, and
 * the only other thing that writes it is Canvas Chat. There is no query feed to
 * build a query for, and the Mac's canvas has no such control either, which is
 * the parity that matters here.
 *
 * It renders nothing rather than being edited out of `CanvasView.tsx`: the
 * component is a fork, and every line changed in it is a line to merge by hand
 * later. The slot it would render into does not exist anyway — see
 * `lib/right-panel.tsx`.
 */
import type { FilterGroup } from "@hermes/shared";

export function QueryBuilder(_props: {
  // Typed as what it is handed rather than as `unknown`. A shim that renders
  // nothing still has to describe the thing it stands in for, or it lies about
  // the caller — which is what the checker caught here.
  value: FilterGroup;
  onChange: (next: FilterGroup) => void;
  types: unknown[];
  tags: string[];
}) {
  return null;
}
