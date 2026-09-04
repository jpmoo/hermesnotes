/**
 * Where a thing being dragged wants to land.
 *
 * Arithmetic with no view in it, ported from the app's `CanvasSnap` — kept
 * separate for the reason that file gives: snapping is the feature most likely
 * to be *nearly* right. One axis working and the other not, a guide drawn where
 * nothing aligns, a rule quietly beating another rule. None of that is visible
 * by looking at it, and all of it can be asked of a pure function directly.
 *
 * Everything here is in document coordinates. The tolerance arrives already
 * divided by the zoom, so a snap feels the same at any scale rather than
 * becoming a magnet at 4x and unreachable at 0.2x.
 */

/** How close, in screen pixels, counts as wanting to snap. */
export const REACH = 6;

/** The three interesting places along an axis: both edges and the middle. */
const stops = (lo, hi) => [lo, (lo + hi) / 2, hi];

/**
 * Nearest wins, and a tie goes to whichever was offered first — which is
 * alignment, because a box already touching an edge must not be pulled off it
 * by a grid line the same distance away.
 */
const better = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return Math.abs(b.delta) < Math.abs(a.delta) ? b : a;
};

const gridOffer = (value, step, tolerance) => {
  const nearest = Math.round(value / step) * step;
  return Math.abs(nearest - value) <= tolerance
    ? { delta: nearest - value, at: nearest, reason: "grid", partner: null }
    : null;
};

/**
 * The gap the neighbours are already using.
 *
 * Only among boxes sharing a band with this one — things in a row are things at
 * the same height, and "evenly spaced" between two objects on opposite sides of
 * the canvas is a coincidence rather than a layout.
 */
function spacingOffer(rect, others, tolerance, horizontal) {
  const band = others.filter((o) =>
    horizontal
      ? o.y < rect.y + rect.h && o.y + o.h > rect.y
      : o.x < rect.x + rect.w && o.x + o.w > rect.x,
  );
  if (band.length < 2) return null;
  const sorted = [...band].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  let best = null;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const gap = horizontal ? b.x - (a.x + a.w) : b.y - (a.y + a.h);
    if (gap <= 0) continue;
    // The same gap again, on the far side of each end of the run: continuing a
    // row to the right and to the left are the same intention.
    for (const anchor of [sorted[0], sorted[sorted.length - 1]]) {
      const before = horizontal ? anchor.x - gap - rect.w : anchor.y - gap - rect.h;
      const after = horizontal ? anchor.x + anchor.w + gap : anchor.y + anchor.h + gap;
      for (const target of [before, after]) {
        const mine = horizontal ? rect.x : rect.y;
        if (Math.abs(target - mine) > tolerance) continue;
        best = better(best, { delta: target - mine, at: target, reason: "spacing", partner: anchor });
      }
    }
  }
  return best;
}

/**
 * A guide is a segment, not an infinite line.
 *
 * One running off both edges of the screen says "something aligns" without
 * saying *what*. Ending it at the two things it joins says both — with a little
 * overshoot, so it reads as a line rather than as the edge of a box.
 */
function guideFor(offer, moved, vertical) {
  const p = offer.partner;
  if (vertical) {
    const lo = Math.min(moved.y, p ? p.y : moved.y) - 8;
    const hi = Math.max(moved.y + moved.h, p ? p.y + p.h : moved.y + moved.h) + 8;
    return { from: { x: offer.at, y: lo }, to: { x: offer.at, y: hi }, reason: offer.reason };
  }
  const lo = Math.min(moved.x, p ? p.x : moved.x) - 8;
  const hi = Math.max(moved.x + moved.w, p ? p.x + p.w : moved.x + moved.w) + 8;
  return { from: { x: lo, y: offer.at }, to: { x: hi, y: offer.at }, reason: offer.reason };
}

/**
 * Where a box being dragged should actually sit.
 *
 * Each axis is decided on its own. Not a simplification — a box can be aligned
 * left with one thing and vertically centred on another, and forcing one answer
 * for both would mean the second never happens.
 */
export function snapMove(rect, others, { grid = null, tolerance = REACH } = {}) {
  let x = null;
  let y = null;

  for (const other of others) {
    for (const mine of stops(rect.x, rect.x + rect.w)) {
      for (const theirs of stops(other.x, other.x + other.w)) {
        if (Math.abs(theirs - mine) <= tolerance) {
          x = better(x, { delta: theirs - mine, at: theirs, reason: "alignment", partner: other });
        }
      }
    }
    for (const mine of stops(rect.y, rect.y + rect.h)) {
      for (const theirs of stops(other.y, other.y + other.h)) {
        if (Math.abs(theirs - mine) <= tolerance) {
          y = better(y, { delta: theirs - mine, at: theirs, reason: "alignment", partner: other });
        }
      }
    }
  }

  x = better(x, spacingOffer(rect, others, tolerance, true));
  y = better(y, spacingOffer(rect, others, tolerance, false));

  // The grid last, so it loses every tie.
  if (grid && grid > 0) {
    x = better(x, gridOffer(rect.x, grid, tolerance));
    y = better(y, gridOffer(rect.y, grid, tolerance));
  }

  const moved = { ...rect, x: rect.x + (x?.delta ?? 0), y: rect.y + (y?.delta ?? 0) };
  const guides = [];
  if (x) guides.push(guideFor(x, moved, true));
  if (y) guides.push(guideFor(y, moved, false));
  return { rect: moved, guides };
}
