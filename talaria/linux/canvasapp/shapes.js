/**
 * The outline of a shape, as an SVG path.
 *
 * Ported from the app's `CanvasShape.path(in:)`, one case at a time, because
 * the first attempt did not port it at all: it approximated each shape with a
 * CSS `clip-path` and let the box's background show through. That works for a
 * rectangle and fails for everything else — a clipped box with no fill and no
 * border is a shape you cannot see, which is exactly what an ellipse and a
 * triangle were. And a clip cannot carry an outline, so those shapes could not
 * have a line round them at all.
 *
 * Drawn rather than clipped, they are what the app draws: a filled path with a
 * stroke on it, in the node's own coordinates.
 */

/**
 * How far the turned corner of a sticky reaches.
 *
 * Fixed, not proportional: a fold is a corner of paper turned over, and a
 * corner does not get bigger because the sheet did.
 */
export const foldSize = (w, h) => Math.min(14, Math.min(w, h) / 3.5);

/** An arc between two lines, the way `addArc(tangent1End:tangent2End:radius:)` draws one. */
const arc = (r) => `a ${r} ${r} 0 0 1`;

export function shapePath(shape, w, h) {
  switch (shape) {
    case "rectangle":
      return `M 0 0 H ${w} V ${h} H 0 Z`;
    case "roundedRectangle": {
      const r = Math.min(14, Math.min(w, h) / 4);
      return (
        `M ${r} 0 H ${w - r} ${arc(r)} ${r} ${r} V ${h - r} ${arc(r)} ${-r} ${r} ` +
        `H ${r} ${arc(r)} ${-r} ${-r} V ${r} ${arc(r)} ${r} ${-r} Z`
      );
    }
    case "ellipse": {
      const rx = w / 2;
      const ry = h / 2;
      return `M 0 ${ry} a ${rx} ${ry} 0 1 0 ${w} 0 a ${rx} ${ry} 0 1 0 ${-w} 0 Z`;
    }
    case "triangle":
      return `M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z`;
    case "postIt": {
      // A rounded square with the bottom-right corner cut off. The three whole
      // corners are rounded and the cut one is not — a crease is a crease.
      const cut = foldSize(w, h);
      const r = Math.min(10, Math.min(w, h) / 6);
      return (
        `M ${r} 0 H ${w - r} ${arc(r)} ${r} ${r} ` +
        `V ${h - cut} L ${w - cut} ${h} ` +
        `H ${r} ${arc(r)} ${-r} ${-r} ` +
        `V ${r} ${arc(r)} ${r} ${-r} Z`
      );
    }
    default:
      return null; // `plain` is a label: words, and no line round them.
  }
}

/** The turned-up corner: the triangle in the gap the page leaves. */
export function foldPath(w, h) {
  const cut = foldSize(w, h);
  return `M ${w} ${h - cut} L ${w - cut} ${h} L ${w - cut} ${h - cut} Z`;
}
