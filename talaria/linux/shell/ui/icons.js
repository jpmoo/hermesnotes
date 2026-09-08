/*
 * A mark for each kind of block.
 *
 * Inline SVG rather than an icon font or a set of files: these are eight small
 * paths, they inherit `currentColor` so they follow the panel's theme without a
 * second palette to keep in step, and the alternative was another asset for the
 * scheme handler to serve.
 *
 * **Keyed by `kind`, never by type name.** The repo's first invariant —
 * `if (type.name === "Task")` is a bug — and this is the surface most likely to
 * break it, because drawing a picture for a thing is exactly where somebody
 * reaches for its name. `kind` is the canonical mapper's word for the shape of
 * a block and survives a user renaming their Task type to Action.
 */

const PATHS = {
  task: "M3 8.5 6 11.5 13 4",
  note: "M4 2h6l3 3v9H4z M10 2v3h3",
  project: "M2 4h4l1.5 2H14v7H2z",
  person: "M8 8a2.6 2.6 0 1 0 0-5.2A2.6 2.6 0 0 0 8 8Z M2.8 14a5.2 5.2 0 0 1 10.4 0",
  organization: "M3 14V3h6v11 M9 7h4v7 M5 5.5h2 M5 8h2 M5 10.5h2",
  event: "M2.5 4.5h11v9h-11z M2.5 7.5h11 M5.5 2.5v3 M10.5 2.5v3",
  // Anything the mapper could not place. Deliberately a shape rather than a
  // question mark: it is not asking, it simply has nothing more specific.
  unknown: "M8 2.5 13.5 8 8 13.5 2.5 8Z",
};

/** An <svg> for a block, sized to sit on a line of text. */
/*
 * The icon a *type* declares, which is a different question from a block's kind.
 *
 * `/types` carries an `icon` — `circle-check-big`, `calendar-days`, `user` —
 * and no `kind` at all, so `blockIcon` cannot answer for a type. The Mac learned
 * this the same way and wrote it down: its New Block menu used to pick an icon
 * by searching the type's *name* for "task" or "person", which drew a wrench for
 * `Organization` and would have lost a renamed `Task` its tick. That is the guess
 * this repo has written down twice as a bug.
 *
 * So this is keyed on what the type says about itself. A name nothing here draws
 * falls back to the same neutral mark an unknown kind gets — honest, and it
 * costs one line to teach it a new one.
 */
const TYPE_PATHS = {
  "circle-check-big": "M14.5 7.4V8a6.5 6.5 0 1 1-3.9-5.95M14.5 3.2 8 9.7l-2-2",
  "calendar-days": "M5.2 1.8v2.4M10.8 1.8v2.4M2.6 6.6h10.8M3.4 3h9.2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  building2: "M4 14V3.2a1 1 0 0 1 1-1h3.4a1 1 0 0 1 1 1V14M9.4 6.4h2.6a1 1 0 0 1 1 1V14M2 14h12M6 5h1.4M6 7.6h1.4M6 10.2h1.4",
  clipboard: "M10 2.4h1.4a1 1 0 0 1 1 1v9.2a1 1 0 0 1-1 1H4.6a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1H6M6 1.4h4a.6.6 0 0 1 .6.6v1.2a.6.6 0 0 1-.6.6H6a.6.6 0 0 1-.6-.6V2a.6.6 0 0 1 .6-.6Z",
  user: "M13 14v-1.4a2.8 2.8 0 0 0-2.8-2.8H5.8A2.8 2.8 0 0 0 3 12.6V14M8 7.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z",
  type: "M3 3.6h10M8 3.6V13M5.8 13h4.4",
};

/** The mark a type declares, or the neutral one. */
export function typeIcon(icon) {
  return draw(TYPE_PATHS[icon] || PATHS.unknown);
}

export function blockIcon(kind) {
  return draw(PATHS[kind] || PATHS.unknown);
}

/** One path, as an inline SVG that follows the panel's color. */
function draw(d) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}
