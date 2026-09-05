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
export function blockIcon(kind) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", PATHS[kind] || PATHS.unknown);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}
