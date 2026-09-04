/**
 * The canvas, read and changed.
 *
 * Requests are relative, which is the whole point of the custom scheme: this
 * page has no idea it is talking to a Unix socket, and the same file works
 * unchanged behind WebKitGTK on Linux.
 *
 * Nodes, text, links with draggable bends, regions, pictures, an inspector, a
 * view you can move and scale, snapping, and the Hermes blocks a node can
 * stand for. Printing is still the app's alone.
 *
 * The rule under all of it: what this page does not understand, it does not
 * destroy. The document is held as it arrived and only `items`, `links` and
 * `regions` are ever touched, so a canvas edited here goes back with its
 * unknown keys and per-item extras intact.
 */

import { REACH, snapMove } from "./snap.js";

const surface = document.getElementById("surface");
const world = document.getElementById("world");
const edges = document.getElementById("edges");
const status = document.getElementById("status");

const CLIP = {
  ellipse: "ellipse(50% 50% at 50% 50%)",
  triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
  postIt: "polygon(0 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%)",
};

/**
 * What a shape looks like before anybody says otherwise.
 *
 * A post-it is paper: a colour and no line round the edge. Every other shape
 * here *is* an outline, which is why one default weight for all of them turns a
 * sticky into a line drawing of one. Mirrors `shapeDefaults` in the daemon and
 * `defaultFill`/`defaultStrokeWidth` in the app — three copies of one fact, and
 * the reason the whole renderer is moving to where the model already lives.
 */
const SHAPE_DEFAULTS = (shape) =>
  shape === "postIt" ? { fill: "#fdf3b6", strokeWidth: 0 } : { fill: null, strokeWidth: 1.5 };
const DEFAULT_FILL = { postIt: "#fdf3b6" };

/**
 * The dash pattern, scaled to the weight, so a dashed hairline and a dashed
 * thick line read as the same idea rather than two different ones. The app's
 * own arithmetic.
 */
const dashFor = (style, w) =>
  style === "dashed" ? `${Math.max(w * 2.5, 3)} ${Math.max(w * 2, 2.5)}` : "";
const NEW_SIZE = { w: 140, h: 70 };

/** The document exactly as the daemon gave it, keys this page never reads and all. */
let doc = { items: [], links: [], regions: [] };
/**
 * The view: which point of the document sits at the top-left, and how big.
 *
 * Everything else in this file works in document coordinates and nothing
 * subtracts a pan — one transform on `#world` carries the whole view, so
 * scrolling and zooming move one element rather than three hundred.
 */
let pan = { x: 0, y: 0 };
let zoom = 1;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;

function applyView() {
  world.style.transform = `scale(${zoom}) translate(${-pan.x}px, ${-pan.y}px)`;
  // Grips and rings are drawn inside the view but must not grow with it: a
  // handle twice the size at 2× is a handle that covers what it points at.
  // Divided by the scale where they are drawn, so they stay the same on the
  // glass — which is also why they are re-drawn on every view change.
  drawLinks();
  showHandle();
}

/** Screen point (client coordinates) → document coordinates. */
function toWorld(clientX, clientY) {
  const box = surface.getBoundingClientRect();
  return { x: (clientX - box.left) / zoom + pan.x, y: (clientY - box.top) / zoom + pan.y };
}

/** Document point → the surface's own pixels, for chrome that lives outside the view. */
const toScreen = (p) => ({ x: (p.x - pan.x) * zoom, y: (p.y - pan.y) * zoom });
/**
 * What is picked, or nothing.
 *
 * `{ kind: "items", ids: [...] }` — one or many, because a group of nodes is
 * how a region gets made and a special case for "exactly one" would be a second
 * selection to keep in step.
 * `{ kind: "link", id }` · `{ kind: "region", id }`
 */
let selected = null;
const pickedItems = () => (selected?.kind === "items" ? selected.ids : []);
const onlyItem = () => (pickedItems().length === 1 ? pickedItems()[0] : null);
let editing = null;
const nodes = new Map(); // item id → element
const regionEls = new Map(); // region id → element
const handleEl = document.getElementById("handle");
const marqueeEl = document.getElementById("marquee");
const inspectorEl = document.getElementById("inspector");
const guideEls = [];

/** A node's own coordinates. Kept as a name because it reads better than
 *  reaching into the item at eleven call sites. */
const at = (i) => ({ x: i.x, y: i.y });

// ── Writing ────────────────────────────────────────────────────────────────

let pending = null;
let inFlight = false;
/**
 * Save the whole document, at most one request at a time.
 *
 * Whole-document writes are the daemon's rule and the right one for a file with
 * a single reader. Overlapping them is not: two PUTs in flight can land in the
 * order they were not sent, and the older one wins. So a save while one is
 * running is remembered and made after, and a burst of drags collapses into one
 * write rather than a queue of them.
 */
function save() {
  if (inFlight) {
    pending = true;
    return;
  }
  inFlight = true;
  fetch("/canvas/document", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  })
    .catch((err) => say(`couldn't save — ${err.message}`))
    .finally(() => {
      inFlight = false;
      if (pending) {
        pending = false;
        save();
      }
    });
}

function say(text) {
  status.textContent = text;
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summarize() {
  const pictures = doc.items.filter((i) => i.image).length;
  say(
    [
      count(doc.items.length, "node"),
      count(doc.links.length, "link"),
      count(doc.regions.length, "region"),
      ...(pictures ? [count(pictures, "picture")] : []),
      ...(linkTrouble ? [`linked blocks unread — ${linkTrouble}`] : []),
    ].join(" · "),
  );
}

// ── Drawing ────────────────────────────────────────────────────────────────

/**
 * Where a line starts, ends, and bends — ported from the app's `LinkGeometry`
 * so that a curve bent here is the same curve there.
 *
 * A line touches a box at the middle of one of its four sides and nowhere else,
 * and which side is chosen by which side-centre is nearest the point the line
 * is heading for. Both ends aim at the same point, so each picks the side
 * facing the other.
 */
const sideCentres = (r) => [
  { x: r.x + r.w / 2, y: r.y },
  { x: r.x + r.w / 2, y: r.y + r.h },
  { x: r.x, y: r.y + r.h / 2 },
  { x: r.x + r.w, y: r.y + r.h / 2 },
];

const nearestSide = (r, p) =>
  sideCentres(r).reduce((best, c) =>
    Math.hypot(c.x - p.x, c.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? c : best,
  );

/**
 * The box an id names — a node's, or a region's.
 *
 * Either end of a line may be a region, which is the whole reason this is not
 * simply a lookup in `items`. A line to a region that resolved to nothing was
 * a line that silently disappeared.
 */
function boxOf(id) {
  const item = doc.items.find((i) => i.id === id);
  if (item) return { x: item.x, y: item.y, w: item.w, h: item.h };
  const region = doc.regions.find((r) => r.id === id);
  return region ? regionBox(region) : null;
}

/**
 * A region is the extent of what it holds, and a margin.
 *
 * Only the padding: the name is written above the box rather than inside it, so
 * the box is the things and nothing else.
 */
const REGION_PAD = 18;
const REGION_TITLE_H = 18;

function regionBox(region) {
  const members = (region.members ?? [])
    .map((id) => doc.items.find((i) => i.id === id))
    .filter(Boolean);
  if (!members.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of members) {
    x0 = Math.min(x0, m.x);
    y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + m.w);
    y1 = Math.max(y1, m.y + m.h);
  }
  return {
    x: x0 - REGION_PAD,
    y: y0 - REGION_PAD,
    w: x1 - x0 + REGION_PAD * 2,
    h: y1 - y0 + REGION_PAD * 2,
  };
}

function geometry(link) {
  const A = boxOf(link.from);
  const B = boxOf(link.to);
  if (!A || !B) return null;
  const bx = link.bendX ?? 0;
  const by = link.bendY ?? 0;
  const aim = {
    x: (A.x + A.w / 2 + B.x + B.w / 2) / 2 + bx,
    y: (A.y + A.h / 2 + B.y + B.h / 2) / 2 + by,
  };
  const a = nearestSide(A, aim);
  const b = nearestSide(B, aim);
  // Solved from the anchors, not the centres. The midpoint of two centres is
  // the midpoint of two anchors only when the boxes match; a region is the size
  // of everything in it, and solving from centres put the control past the far
  // anchor — the line bulged inward and touched the border from the wrong side.
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return {
    start: a,
    end: b,
    // Where the maths wants it…
    control: { x: mid.x + 2 * bx, y: mid.y + 2 * by },
    // …and where the curve actually passes, which is where the grip goes.
    handle: { x: mid.x + bx, y: mid.y + by },
    mid,
  };
}

const pointAt = (g, t) => {
  const u = 1 - t;
  return {
    x: u * u * g.start.x + 2 * u * t * g.control.x + t * t * g.end.x,
    y: u * u * g.start.y + 2 * u * t * g.control.y + t * t * g.end.y,
  };
};

/** Sampled rather than solved: a click test finer than anybody can aim. */
function distanceToLink(g, p) {
  let best = Infinity;
  for (let i = 0; i <= 24; i++) {
    const q = pointAt(g, i / 24);
    best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return best;
}

const svg = (tag, attrs) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

function drawLinks() {
  edges.innerHTML = "";
  for (const link of doc.links) {
    const g = geometry(link);
    if (!g) continue;
    const on = selected?.kind === "link" && selected.id === link.id;
    const color = link.color ?? "currentColor";
    const width = link.width ?? 1.5;
    const d = `M ${g.start.x} ${g.start.y} Q ${g.control.x} ${g.control.y} ${g.end.x} ${g.end.y}`;

    // A line is a few pixels wide and a target has to be bigger than the thing
    // it stands for. An invisible fat copy underneath is what makes one
    // clickable without drawing a fat line.
    const hit = svg("path", { d, fill: "none", stroke: "transparent", "stroke-width": 14 / zoom });
    hit.classList.add("hit");
    hit.dataset.link = link.id;
    edges.append(hit);

    const line = svg("path", {
      d,
      fill: "none",
      stroke: on ? "#5fa4b5" : color,
      "stroke-width": on ? Math.max(width, 2) : width,
    });
    const dash = dashFor(link.style, width);
    if (dash) line.setAttribute("stroke-dasharray", dash);
    edges.append(line);
    // A double line is two lines: the app draws a second, tighter copy rather
    // than one thick stroke with a gap down the middle, and a canvas that
    // disagreed about that would look wrong in whichever renderer it was not
    // drawn in.
    if (link.style === "double") {
      edges.append(
        svg("path", { d, fill: "none", stroke: on ? "#5fa4b5" : color, "stroke-width": Math.max(width / 3, 0.5) }),
      );
    }

    // The arrowhead, pointing the way the curve arrives.
    const dx = 2 * (g.end.x - g.control.x);
    const dy = 2 * (g.end.y - g.control.y);
    const len = Math.max(Math.hypot(dx, dy), 0.0001);
    const ux = dx / len;
    const uy = dy / len;
    const size = 7 + width;
    edges.append(
      svg("path", {
        d:
          `M ${g.end.x} ${g.end.y} ` +
          `L ${g.end.x - size * ux + (size / 2.4) * uy} ${g.end.y - size * uy - (size / 2.4) * ux} ` +
          `L ${g.end.x - size * ux - (size / 2.4) * uy} ${g.end.y - size * uy + (size / 2.4) * ux} Z`,
        fill: on ? "#5fa4b5" : color,
      }),
    );

    if (on) {
      // The grip sits where the curve passes, which is the midpoint plus the
      // bend — not the control point, which is twice as far out and not on the
      // line at all.
      const grip = svg("circle", { cx: g.handle.x, cy: g.handle.y, r: 6 / zoom });
      grip.classList.add("grip");
      grip.dataset.grip = link.id;
      edges.append(grip);
    }
  }
}

function place(el, item) {
  const { x, y } = at(item);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${item.w}px`;
  el.style.height = `${item.h}px`;
}

function style(el, item) {
  const weight = item.strokeWidth ?? 1.5;
  el.style.background = item.fill ?? DEFAULT_FILL[item.shape] ?? "transparent";
  el.style.color = item.textColor ?? "inherit";
  el.style.justifyContent = { leading: "flex-start", trailing: "flex-end" }[item.hAlign] ?? "center";
  el.style.alignItems = { top: "flex-start", bottom: "flex-end" }[item.vAlign] ?? "center";
  el.style.textAlign = item.hAlign === "leading" ? "left" : item.hAlign === "trailing" ? "right" : "center";
  el.style.clipPath = CLIP[item.shape] ?? "";
  el.style.borderRadius = item.shape === "roundedRectangle" ? "14px" : "2px";
  // A clipped shape cannot also carry a border — the clip cuts it off. Faithful
  // outlines for those are a later slice; this is honest about which shapes
  // currently get one rather than drawing a wrong line on the rest.
  el.style.border =
    weight > 0 && !CLIP[item.shape] && item.shape && item.shape !== "plain"
      ? `${weight}px ${item.strokeStyle === "solid" || !item.strokeStyle ? "solid" : item.strokeStyle} ${item.stroke ?? "currentColor"}`
      : "";
}

/**
 * The strip along the bottom of a node that stands for a Hermes block.
 *
 * Three separate facts, and it matters that they stay separate. Whether it can
 * be finished — only a type with a task profile gets a box. Whether it *is*.
 * And whether the block is still there at all, which is where a node stops
 * being about styling and starts being about trust: a block that has been
 * archived still exists, a block that has been deleted does not, and a node
 * that showed them the same way would be telling somebody their work was gone.
 */
function badge(el, item) {
  const block = linked.get(item.blockId);
  const strip = document.createElement("div");
  strip.className = "badge";

  if (!block) {
    strip.classList.add("unknown");
    strip.textContent = "…";
    el.append(strip);
    return;
  }
  if (block.missing) {
    el.classList.add("gone");
    strip.classList.add("gone");
    strip.textContent = "deleted in Hermes";
    el.append(strip);
    return;
  }
  if (block.archived) {
    el.classList.add("archived");
    strip.classList.add("archived");
  }

  const type = block.typeId ? types.get(block.typeId) : null;
  if (type?.statusKey) {
    const box = document.createElement("button");
    box.className = "done";
    box.dataset.done = item.id;
    box.textContent = isDone(block) ? "☑" : "☐";
    box.title = isDone(block) ? "Mark not done" : "Mark done";
    strip.append(box);
    if (isDone(block)) el.classList.add("done");
  }

  const name = document.createElement("span");
  name.className = "badge-type";
  name.textContent = block.archived ? `${type?.name ?? "block"} · archived` : (type?.name ?? "block");
  strip.append(name);

  if (block.url) {
    const open = document.createElement("a");
    open.className = "open";
    open.href = block.url;
    open.textContent = "↗";
    open.title = "Open in Hermes";
    strip.append(open);
  }
  el.append(strip);
}

function node(item) {
  const el = document.createElement("div");
  el.className = "node";
  el.dataset.id = item.id;
  place(el, item);
  style(el, item);
  if (item.image) {
    const img = document.createElement("img");
    img.src = `/canvas/image/${encodeURIComponent(item.image)}`;
    img.alt = item.text || "";
    img.draggable = false;
    el.append(img);
  } else {
    // A linked node wears its block's title as of now — a task renamed in
    // Hermes should not still read as its old name here. Falling back to the
    // words it was made with when Hermes cannot be reached.
    const block = item.blockId ? linked.get(item.blockId) : null;
    el.textContent = block && !block.missing ? block.title : (item.text ?? "");
  }
  if (item.blockId) badge(el, item);
  world.append(el);
  nodes.set(item.id, el);
  return el;
}

/**
 * The boxes drawn round groups of nodes.
 *
 * Redrawn rather than moved, because a region has no position of its own — it
 * is wherever its members are, so anything that moves a member moves it.
 * Behind the nodes, since it is the ground they stand on.
 */
function drawRegions() {
  for (const el of regionEls.values()) el.remove();
  regionEls.clear();
  for (const region of doc.regions) {
    const box = regionBox(region);
    if (!box) continue;
    const el = document.createElement("div");
    el.className = "region";
    el.dataset.region = region.id;
    if (selected?.kind === "region" && selected.id === region.id) el.classList.add("selected");
    Object.assign(el.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.w}px`,
      height: `${box.h}px`,
      background: region.fill ?? "transparent",
      borderColor: region.stroke ?? "currentColor",
      borderWidth: `${region.strokeWidth ?? 1.5}px`,
      borderStyle: region.strokeStyle ?? "dashed",
    });
    const title = document.createElement("div");
    title.className = "region-title";
    title.dataset.regionTitle = region.id;
    title.textContent = region.title ?? "";
    title.style.color = region.textColor ?? "inherit";
    title.style.textAlign =
      region.hAlign === "center" ? "center" : region.hAlign === "trailing" ? "right" : "left";
    el.append(title);
    // Before the SVG, so lines and nodes both sit over it.
    world.prepend(el);
    regionEls.set(region.id, el);
  }
}

function draw() {
  for (const el of nodes.values()) el.remove();
  nodes.clear();
  for (const item of doc.items) node(item);
  drawRegions();
  drawLinks();
  showSelection();
  summarize();
}

function showSelection() {
  const picked = pickedItems();
  for (const [id, el] of nodes) el.classList.toggle("selected", picked.includes(id));
  for (const [id, el] of regionEls)
    el.classList.toggle("selected", selected?.kind === "region" && selected.id === id);
  // Lines are redrawn rather than restyled: which one is picked changes its
  // color, its weight, and whether it carries a grip, and rebuilding four
  // shapes is less code than keeping three of them in step.
  drawLinks();
  showHandle();
  showInspector();
}

/**
 * The connector, on the selected node.
 *
 * One handle rather than four. Which side a line actually leaves from is
 * decided by the geometry once both ends are known, so a handle per side would
 * be offering a choice that is not taken.
 */
function showHandle() {
  handleEl.hidden = true;
  // One node only. With several picked there is no single thing a line would
  // leave from, and offering a ring that means "whichever" is offering a guess.
  const id = onlyItem();
  if (!id) return;
  const item = find(id);
  if (!item) return;
  // Outside the view, so it keeps its size at any zoom — the ring is a thing
  // you aim at, and a target that shrinks to a dot at 30% is not one.
  const p = toScreen({ x: item.x + item.w, y: item.y + item.h / 2 });
  handleEl.style.left = `${p.x}px`;
  handleEl.style.top = `${p.y}px`;
  handleEl.hidden = false;
}

// ── Editing ────────────────────────────────────────────────────────────────

const find = (id) => doc.items.find((i) => i.id === id);

/** An id shaped like the app's own: uppercase, hyphenated. */
const newId = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toUpperCase();

function edit(id) {
  const el = nodes.get(id);
  const item = find(id);
  if (!el || !item || item.image) return;
  editing = id;
  el.contentEditable = "plaintext-only";
  el.focus();
  // The caret at the end, not at the start: the ordinary reason to open a node
  // is to add to what it says.
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const done = () => {
    el.contentEditable = "false";
    el.removeEventListener("blur", done);
    editing = null;
    const text = el.textContent ?? "";
    if (text === item.text) return;
    item.text = text;
    // A node nobody wrote in is a gesture, not a thing somebody made — the
    // same rule the app applies when a new label is left empty.
    if (!text.trim() && !item.image) {
      doc.items = doc.items.filter((i) => i.id !== id);
      el.remove();
      nodes.delete(id);
      drawLinks();
    }
    save();
    summarize();
  };
  el.addEventListener("blur", done);
}

function create(x, y) {
  const item = {
    id: newId(),
    x: Math.round(x - NEW_SIZE.w / 2),
    y: Math.round(y - NEW_SIZE.h / 2),
    w: NEW_SIZE.w,
    h: NEW_SIZE.h,
    text: "",
    shape: "plain",
    hAlign: "center",
    vAlign: "middle",
    strokeWidth: 1.5,
    strokeStyle: "solid",
  };
  doc.items.push(item);
  node(item);
  selected = { kind: "items", ids: [item.id] };
  showSelection();
  edit(item.id);
}

function remove(id) {
  doc.items = doc.items.filter((i) => i.id !== id);
  // A line with only one end left cannot be drawn and must not be kept — it
  // would be written back out and outlive any chance of meaning anything.
  doc.links = doc.links.filter((l) => l.from !== id && l.to !== id);
  // A region keeps the members still here; one holding nothing is over. And a
  // region that has just ended takes its own lines with it — the app does this
  // and the first version here did not, which left a line tied to a group that
  // no longer existed: invisible, saved, and waiting.
  const emptied = doc.regions
    .filter((r) => (r.members ?? []).every((m) => m === id))
    .map((r) => r.id);
  doc.regions = doc.regions
    .map((r) => ({ ...r, members: (r.members ?? []).filter((m) => m !== id) }))
    .filter((r) => (r.members ?? []).length > 0);
  doc.links = doc.links.filter((l) => !emptied.includes(l.from) && !emptied.includes(l.to));
  nodes.get(id)?.remove();
  nodes.delete(id);
  if (selected?.kind === "items") {
    const left = selected.ids.filter((x) => x !== id);
    selected = left.length ? { kind: "items", ids: left } : null;
  }
  showSelection();
  save();
  summarize();
}

// ── Linking ────────────────────────────────────────────────────────────────

/**
 * Tie two nodes together, or cut them apart.
 *
 * One gesture does both, which is the app's rule: dropping on something already
 * connected is how you disconnect it. There is no separate cut and nothing to
 * aim at to perform one — which matters most for the line you can barely see,
 * because the thing you can always hit is the node at its end.
 */
function link(fromId, toId) {
  if (fromId === toId) return;
  const existing = doc.links.find(
    (l) => (l.from === fromId && l.to === toId) || (l.from === toId && l.to === fromId),
  );
  if (existing) {
    doc.links = doc.links.filter((l) => l.id !== existing.id);
    if (selected?.kind === "link" && selected.id === existing.id) selected = null;
  } else {
    doc.links.push({
      id: newId(),
      from: fromId,
      to: toId,
      bendX: 0,
      bendY: 0,
      width: 1.5,
      style: "solid",
    });
  }
  showSelection();
  save();
  summarize();
}

function removeLink(id) {
  doc.links = doc.links.filter((l) => l.id !== id);
  selected = null;
  showSelection();
  save();
  summarize();
}

// ── The inspector ──────────────────────────────────────────────────────────

/**
 * What is picked, as things whose style can be changed.
 *
 * One list, whatever kind is selected, so every control below is written once
 * and applies to one node or to nine without knowing which.
 */
function picked() {
  if (!selected) return [];
  if (selected.kind === "items") return pickedItems().map(find).filter(Boolean);
  if (selected.kind === "link") return doc.links.filter((l) => l.id === selected.id);
  if (selected.kind === "region") return doc.regions.filter((r) => r.id === selected.id);
  return [];
}

/** Which controls make sense for what is picked. A line has no shape. */
const FIELDS = {
  items: ["shape", "fill", "textColor", "stroke", "strokeWidth", "strokeStyle", "hAlign", "vAlign"],
  link: ["stroke", "strokeWidth", "strokeStyle"],
  region: ["fill", "textColor", "stroke", "strokeWidth", "strokeStyle", "hAlign"],
};

const ALIGNS = {
  hAlign: [["leading", "◧"], ["center", "▣"], ["trailing", "◨"]],
  vAlign: [["top", "⌃"], ["middle", "•"], ["bottom", "⌄"]],
};

/** A line's colour and weight live under different names than a box's. */
const nameFor = (kind, field) =>
  kind === "link" ? { stroke: "color", strokeWidth: "width", strokeStyle: "style" }[field] : field;

function apply(field, value) {
  const kind = selected.kind;
  for (const thing of picked()) {
    const key = nameFor(kind, field);
    if (field === "shape") {
      // Changing shape carries the new shape's defaults, but only over values
      // nobody has chosen — the app's own rule. A fill somebody picked is a
      // decision and survives becoming a post-it.
      const was = SHAPE_DEFAULTS(thing.shape);
      const now = SHAPE_DEFAULTS(value);
      if ((thing.fill ?? null) === was.fill) thing.fill = now.fill;
      if ((thing.strokeWidth ?? 1.5) === was.strokeWidth) thing.strokeWidth = now.strokeWidth;
    }
    thing[key] = value;
  }
  draw();
  save();
}

function showInspector() {
  const kind = selected?.kind;
  const things = picked();
  if (!kind || !things.length) {
    inspectorEl.hidden = true;
    return;
  }
  inspectorEl.hidden = false;
  document.getElementById("i-what").textContent =
    kind === "link" ? "Line" : kind === "region" ? "Group" : count(things.length, "node");

  const shown = FIELDS[kind] ?? [];
  for (const el of inspectorEl.querySelectorAll("[data-for]")) {
    el.hidden = !shown.includes(el.dataset.for);
  }
  // The first of what is picked fills the controls. With several selected they
  // will not all agree; showing one of them and changing all of them is what
  // every inspector does, and pretending otherwise needs a mixed state nobody
  // asked for.
  const first = things[0];
  for (const field of ["shape", "fill", "textColor", "stroke", "strokeWidth", "strokeStyle"]) {
    const input = document.getElementById(`i-${field}`);
    if (!input) continue;
    const v = first[nameFor(kind, field)];
    if (input.type === "color") input.value = typeof v === "string" ? v : "#888888";
    else if (input.type === "number") input.value = v ?? 1.5;
    else input.value = v ?? (field === "shape" ? "plain" : "solid");
  }
  for (const [field, options] of Object.entries(ALIGNS)) {
    const row = document.getElementById(`i-${field}`);
    if (!row) continue;
    row.innerHTML = "";
    for (const [value, glyph] of options) {
      const b = document.createElement("button");
      b.textContent = glyph;
      b.title = value;
      if ((first[field] ?? (field === "hAlign" ? "center" : "middle")) === value) b.classList.add("on");
      b.addEventListener("click", () => apply(field, value));
      row.append(b);
    }
  }
}

// ── Regions ────────────────────────────────────────────────────────────────

/** Draw a box round what is picked. Two or more: one node is not a group. */
function group() {
  const ids = pickedItems();
  if (ids.length < 2) return;
  const region = {
    id: newId(),
    members: [...ids],
    title: "",
    hAlign: "leading",
    strokeWidth: 1.5,
    strokeStyle: "dashed",
  };
  doc.regions.push(region);
  selected = { kind: "region", id: region.id };
  draw();
  save();
}

/**
 * Take the box away, and leave what was in it.
 *
 * A region is a way of saying some things belong together; removing it is
 * unsaying that, not deleting them. Deleting the members is what backspace on
 * the members does.
 */
function ungroup(id) {
  doc.regions = doc.regions.filter((r) => r.id !== id);
  // A line tied to the region has lost its end and cannot be drawn.
  doc.links = doc.links.filter((l) => l.from !== id && l.to !== id);
  selected = null;
  draw();
  save();
}

function retitle(id) {
  const el = regionEls.get(id)?.firstChild;
  const region = doc.regions.find((r) => r.id === id);
  if (!el || !region) return;
  editing = id;
  el.contentEditable = "plaintext-only";
  el.focus();
  const done = () => {
    el.contentEditable = "false";
    el.removeEventListener("blur", done);
    editing = null;
    const text = el.textContent ?? "";
    if (text === region.title) return;
    region.title = text;
    save();
  };
  el.addEventListener("blur", done);
}

// ── Pointing ───────────────────────────────────────────────────────────────

/** A move, a bend, or a line being drawn — whichever the hand is doing. */
let drag = null;
/** The line drawn while connecting, which is not in the document yet. */
let ghost = null;

/** Where the pointer is, in the surface's own coordinates. */
function local(e) {
  return toWorld(e.clientX, e.clientY);
}

/**
 * The last place the canvas was touched.
 *
 * A paste has no position of its own, and putting the picture in the middle of
 * the view is a guess about where somebody is looking. Where they last pressed
 * is not a guess.
 */
let lastPoint = { x: 200, y: 160 };

/** The node under a point, for deciding where a dragged line has landed. */
function nodeAt(p) {
  // Last first: later items are drawn on top, so the topmost is the one meant.
  for (let i = doc.items.length - 1; i >= 0; i--) {
    const it = doc.items[i];
    const { x, y } = at(it);
    if (p.x >= x && p.x <= x + it.w && p.y >= y && p.y <= y + it.h) return it;
  }
  return null;
}

surface.addEventListener("pointerdown", (e) => {
  if (editing) return;
  // The badge is a control, not part of the box: pressing a checkbox should
  // tick it, not begin dragging the node it sits on.
  const done = e.target.dataset?.done;
  if (done) {
    const item = find(done);
    if (item) void toggleDone(item);
    return;
  }
  if (e.target.className === "open") return;
  const p = local(e);
  lastPoint = p;

  // The grip, before anything else: it sits over the canvas and is small, so a
  // node happening to be underneath must not win the press.
  const grip = e.target.dataset?.grip;
  if (grip) {
    const g = geometry(doc.links.find((l) => l.id === grip));
    if (g) {
      drag = { what: "bend", id: grip, mid: g.mid, moved: false };
      surface.setPointerCapture?.(e.pointerId);
      return;
    }
  }

  // The connector on the selected node starts a line rather than a move. The
  // selection is checked rather than assumed: the handle is hidden when there
  // is nothing to draw from, and "hidden" is a weaker promise than "absent".
  if (e.target === handleEl && onlyItem()) {
    drag = { what: "connect", from: onlyItem(), to: p, moved: false };
    surface.setPointerCapture?.(e.pointerId);
    return;
  }

  const el = e.target.closest?.(".node");
  if (el) {
    const id = el.dataset.id;
    // Shift adds to what is picked rather than replacing it — the way a group
    // is assembled when a rectangle round them would catch something else too.
    if (e.shiftKey && selected?.kind === "items") {
      selected = {
        kind: "items",
        ids: selected.ids.includes(id) ? selected.ids.filter((x) => x !== id) : [...selected.ids, id],
      };
    } else if (!pickedItems().includes(id)) {
      selected = { kind: "items", ids: [id] };
    }
    showSelection();
    // Every picked node moves, not just the one under the hand.
    const moving = pickedItems();
    drag = {
      what: "move",
      startX: e.clientX,
      startY: e.clientY,
      from: moving.map((mid) => ({ id: mid, ox: find(mid).x, oy: find(mid).y })),
      moved: false,
    };
    el.setPointerCapture(e.pointerId);
    return;
  }

  // A region's own box, which moves everything it holds.
  const rid = e.target.dataset?.region ?? e.target.dataset?.regionTitle;
  if (rid) {
    selected = { kind: "region", id: rid };
    showSelection();
    const region = doc.regions.find((r) => r.id === rid);
    drag = {
      what: "move",
      startX: e.clientX,
      startY: e.clientY,
      from: (region?.members ?? [])
        .map((mid) => find(mid))
        .filter(Boolean)
        .map((m) => ({ id: m.id, ox: m.x, oy: m.y })),
      moved: false,
    };
    surface.setPointerCapture?.(e.pointerId);
    return;
  }

  // Empty canvas — unless a line runs through it. Lines are hit by distance
  // rather than by what the pointer landed on, because the thing drawn is a few
  // pixels wide and the thing aimed at should not have to be.
  let nearest = null;
  let best = 10;
  for (const l of doc.links) {
    const g = geometry(l);
    if (!g) continue;
    const d = distanceToLink(g, p);
    if (d < best) {
      best = d;
      nearest = l;
    }
  }
  if (nearest) {
    selected = { kind: "link", id: nearest.id };
    showSelection();
    return;
  }
  // Nothing under the pointer: a rectangle, which is how several things get
  // picked at once and therefore how a region gets made.
  selected = null;
  showSelection();
  drag = { what: "marquee", from: p, to: p, moved: false };
  surface.setPointerCapture?.(e.pointerId);
});

surface.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const p = local(e);

  if (drag.what === "connect") {
    drag.moved = true;
    drag.to = p;
    drawGhost(drag);
    return;
  }

  if (drag.what === "bend") {
    drag.moved = true;
    const l = doc.links.find((x) => x.id === drag.id);
    if (!l) return;
    // The grip sits at midpoint + bend, so the bend *is* the distance from the
    // midpoint to where the hand is. The control point is twice that, which is
    // what makes the curve pass under the grip rather than beside it.
    l.bendX = Math.round(p.x - drag.mid.x);
    l.bendY = Math.round(p.y - drag.mid.y);
    drawLinks();
    return;
  }

  if (drag.what === "marquee") {
    drag.moved = true;
    drag.to = p;
    const box = marqueeBox(drag);
    const a = toScreen(box);
    const b = toScreen({ x: box.x + box.w, y: box.y + box.h });
    Object.assign(marqueeEl.style, {
      left: `${a.x}px`,
      top: `${a.y}px`,
      width: `${b.x - a.x}px`,
      height: `${b.y - a.y}px`,
    });
    marqueeEl.hidden = false;
    // Live, so the rectangle shows what it has rather than what it will have.
    selected = { kind: "items", ids: itemsIn(box) };
    showSelection();
    return;
  }

  // Divided by the scale. The pointer moves in screen pixels and the document
  // is in its own units, and applying one as the other means a node travelling
  // twice as far as the hand at 2× and half as far at 0.5× — it slides out from
  // under the pointer, which reads as the canvas being broken rather than as an
  // arithmetic slip.
  const dx = (e.clientX - drag.startX) / zoom;
  const dy = (e.clientY - drag.startY) / zoom;
  // The three-pixel threshold stays in screen pixels: it is about the hand
  // being steady, not about the document.
  if (!drag.moved && Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < 3) return;
  drag.moved = true;
  // Where it wants to be, then where it should be.
  //
  // The whole moving set is snapped as one box and the answer applied to all of
  // them, rather than each node snapping to its own neighbour: nine boxes each
  // finding a different edge would pull the group apart, which is the opposite
  // of what dragging nine things at once means.
  const moving = new Set(drag.from.map((m) => m.id));
  const wanted = drag.from.map((m) => ({ ...find(m.id), x: m.ox + dx, y: m.oy + dy })).filter(Boolean);
  let shift = { x: 0, y: 0 };
  let guides = [];
  if (wanted.length) {
    const x0 = Math.min(...wanted.map((i) => i.x));
    const y0 = Math.min(...wanted.map((i) => i.y));
    const hull = {
      x: x0,
      y: y0,
      w: Math.max(...wanted.map((i) => i.x + i.w)) - x0,
      h: Math.max(...wanted.map((i) => i.y + i.h)) - y0,
    };
    const snapped = snapMove(
      hull,
      doc.items.filter((i) => !moving.has(i.id)),
      // Converted from screen pixels, so a snap feels the same at every scale
      // rather than becoming a magnet at 4x and unreachable at 0.2x.
      { grid: gridOn ? 24 : null, tolerance: REACH / zoom },
    );
    shift = { x: snapped.rect.x - hull.x, y: snapped.rect.y - hull.y };
    guides = snapped.guides;
  }
  for (const m of drag.from) {
    const item = find(m.id);
    if (!item) continue;
    item.x = Math.round(m.ox + dx + shift.x);
    item.y = Math.round(m.oy + dy + shift.y);
    place(nodes.get(m.id), item);
  }
  drawGuides(guides);
  // A region has no position of its own — it is wherever its members are — so
  // moving anything inside one redraws it.
  drawRegions();
  // Lines follow what they are tied to while it moves, rather than snapping
  // into place when the hand comes off.
  drawLinks();
  showHandle();
});

const marqueeBox = (d) => ({
  x: Math.min(d.from.x, d.to.x),
  y: Math.min(d.from.y, d.to.y),
  w: Math.abs(d.to.x - d.from.x),
  h: Math.abs(d.to.y - d.from.y),
});

/** Everything the rectangle touches — overlap, not containment. */
function itemsIn(box) {
  return doc.items
    .filter((i) => {
      const { x, y } = at(i);
      return x < box.x + box.w && x + i.w > box.x && y < box.y + box.h && y + i.h > box.y;
    })
    .map((i) => i.id);
}

surface.addEventListener("pointerup", (e) => {
  if (drag?.what === "connect") {
    clearGhost();
    const target = nodeAt(local(e));
    if (target) link(drag.from, target.id);
  } else if (drag?.what === "marquee") {
    marqueeEl.hidden = true;
    // Nothing to save: picking things changes nothing about the document.
  } else if (drag?.moved) {
    // Saved on release, not on every frame: a canvas written a hundred times
    // crossing the screen is a hundred writes of the same fact.
    save();
  }
  drawGuides([]);
  drag = null;
});

/** The line being drawn, before there is anything to draw it from. */
function drawGhost(d) {
  const from = find(d.from);
  if (!from) return;
  const a = nearestSide({ x: from.x, y: from.y, w: from.w, h: from.h }, d.to);
  if (!ghost) {
    ghost = svg("path", { fill: "none", stroke: "#5fa4b5", "stroke-width": 1.5, "stroke-dasharray": "5 4" });
    edges.append(ghost);
  }
  ghost.setAttribute("d", `M ${a.x} ${a.y} L ${d.to.x} ${d.to.y}`);
  // What it would land on, said before it lands. Dropping on something already
  // connected disconnects it, and that is worth knowing beforehand rather than
  // discovering.
  const over = nodeAt(d.to);
  for (const [id, el] of nodes) el.classList.toggle("target", !!over && over.id === id && id !== d.from);
}

function clearGhost() {
  ghost?.remove();
  ghost = null;
  for (const el of nodes.values()) el.classList.remove("target");
}

surface.addEventListener("dblclick", (e) => {
  const el = e.target.closest?.(".node");
  if (el) {
    edit(el.dataset.id);
    return;
  }
  const rid = e.target.dataset?.regionTitle ?? e.target.dataset?.region;
  if (rid) {
    retitle(rid);
    return;
  }
  const box = surface.getBoundingClientRect();
  create(e.clientX - box.left, e.clientY - box.top);
});

window.addEventListener("keydown", (e) => {
  if (editing) {
    // Escape gives whatever is being written in its focus-out, which commits.
    if (e.key === "Escape") (nodes.get(editing) ?? regionEls.get(editing)?.firstChild)?.blur();
    return;
  }
  // The view, which is not about what is picked and must work when nothing is.
  if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
    fit(false);
    e.preventDefault();
    return;
  }
  if (e.key === "1" && (e.metaKey || e.ctrlKey)) {
    fit(true);
    e.preventDefault();
    return;
  }
  if (e.key === "'" || e.key === "\"") {
    gridOn = !gridOn;
    surface.classList.toggle("grid", gridOn);
    say(gridOn ? "grid on" : "grid off");
    e.preventDefault();
    return;
  }
  if (!selected) return;
  if (e.key === "Backspace" || e.key === "Delete") {
    // Removing a region takes the box away and leaves what was in it; removing
    // nodes removes the nodes. Backspace means both, and which one it means is
    // decided by what is picked — the box, or the things.
    if (selected.kind === "link") removeLink(selected.id);
    else if (selected.kind === "region") ungroup(selected.id);
    else for (const id of [...pickedItems()]) remove(id);
    e.preventDefault();
  } else if ((e.key === "g" || e.key === "G") && selected.kind === "items") {
    group();
    e.preventDefault();
  }
});

// ── Blocks this canvas points at ───────────────────────────────────────────

/**
 * What Hermes says about the blocks on this canvas, by id.
 *
 * A linked node shows the block's title rather than its own words, and shows it
 * as of now: a task renamed in Hermes should not still read as its old name
 * here. The words in the document are left exactly as they were — this is a
 * view of somebody else's data, and writing their title into our file would
 * make the canvas the second place it lives.
 */
const linked = new Map();
/** Why the last ask failed, if it did. Shown rather than swallowed. */
let linkTrouble = null;
/** Types, for the icon and for how a type says a thing is done. */
let types = new Map();

async function loadLinked() {
  linkTrouble = null;
  const ids = [...new Set(doc.items.map((i) => i.blockId).filter(Boolean))];
  if (!ids.length) {
    linked.clear();
    return;
  }
  try {
    if (!types.size) {
      const t = await fetch("/types").then((r) => r.json());
      types = new Map((t.data ?? []).map((x) => [x.id, x]));
    }
    const res = await fetch("/linked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error(String(res.status));
    for (const b of (await res.json()).data ?? []) linked.set(b.id, b);
  } catch (err) {
    // Offline, or a daemon that cannot reach Hermes. A linked node then shows
    // the words it was made with, which is what it had before anybody asked —
    // not an error, and not an empty box.
    //
    // But it is said out loud. Swallowed entirely, "Hermes is unreachable" and
    // "these nodes point at nothing" look identical, and the first is temporary
    // while the second means somebody's blocks are gone.
    linkTrouble = err.message || "couldn't reach Hermes";
  }
}

/** Whether a linked block is finished, by its own type's account. */
function isDone(block) {
  const type = block.typeId ? types.get(block.typeId) : null;
  // Never by looking for a field called "status": what makes a field a status
  // is the profile pointing at it, and a type is a row the user renames.
  return Boolean(type?.completeValues?.length && block.status && type.completeValues.includes(block.status));
}

/**
 * Mark a linked block done, or not done.
 *
 * Written through the daemon's own `complete`, which knows what a type means by
 * finished. Sending a literal value from here would be this canvas deciding
 * that "done" is spelled the way it happens to be spelled on one account.
 */
async function toggleDone(item) {
  const block = linked.get(item.blockId);
  if (!block) return;
  const type = block.typeId ? types.get(block.typeId) : null;
  const values = type?.statusOptions ?? [];
  const undone = values.find((v) => !type?.completeValues?.includes(v));
  try {
    await fetch("/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "complete",
        blockId: item.blockId,
        ...(isDone(block) && undone ? { status: undone } : {}),
      }),
    });
    await loadLinked();
    draw();
  } catch (err) {
    say(`couldn't write that to Hermes — ${err.message}`);
  }
}

// ── Guides ─────────────────────────────────────────────────────────────────

/** Whether the dotted grid is one of the things a drag can land on. */
let gridOn = false;

/**
 * The lines shown while a snap is holding.
 *
 * Drawn in the same layer as the links and cleared the moment a drag ends: a
 * guide is a statement about what is happening now, and one left behind is a
 * claim that something aligns when nothing is moving.
 */
function drawGuides(guides) {
  for (const el of guideEls) el.remove();
  guideEls.length = 0;
  for (const g of guides) {
    const line = svg("line", {
      x1: g.from.x,
      y1: g.from.y,
      x2: g.to.x,
      y2: g.to.y,
      // Thin at any zoom, like every other piece of chrome drawn inside the
      // view.
      "stroke-width": 1 / zoom,
      "stroke-dasharray": `${4 / zoom} ${3 / zoom}`,
    });
    line.classList.add("guide", `guide-${g.reason}`);
    edges.append(line);
    guideEls.push(line);
  }
}

// ── The view ───────────────────────────────────────────────────────────────

/**
 * Scroll to pan, pinch or ⌘-scroll to zoom.
 *
 * A trackpad pinch arrives as a wheel event with `ctrlKey` set, which is a
 * browser convention rather than anything to do with the control key — and it
 * is why the two live in one handler. Zoom is anchored on the pointer, so the
 * thing under it stays under it; anchoring on the centre makes zooming feel
 * like the canvas is running away.
 */
surface.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const before = toWorld(e.clientX, e.clientY);
      // Exponential, so a step feels the same size at every scale — a fixed
      // increment is a crawl at 4× and a leap at 0.2×.
      zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * Math.exp(-e.deltaY / 300)));
      const after = toWorld(e.clientX, e.clientY);
      pan.x += before.x - after.x;
      pan.y += before.y - after.y;
    } else {
      // In document units, so a scroll moves the same distance on the glass
      // whatever the zoom.
      pan.x += e.deltaX / zoom;
      pan.y += e.deltaY / zoom;
    }
    applyView();
  },
  { passive: false },
);

/** Put the whole document on screen, or return to life size. */
function fit(all = true) {
  const box = surface.getBoundingClientRect();
  if (!all || !doc.items.length) {
    zoom = 1;
    pan = { x: -40, y: -40 };
    applyView();
    return;
  }
  const xs = doc.items.flatMap((i) => [i.x, i.x + i.w]);
  const ys = doc.items.flatMap((i) => [i.y, i.y + i.h]);
  const x0 = Math.min(...xs) - 40;
  const y0 = Math.min(...ys) - 40;
  const w = Math.max(...xs) - x0 + 40;
  const h = Math.max(...ys) - y0 + 40;
  // Never magnified to fill the window: a canvas with two nodes on it blown up
  // to 4× is not "fitted", it is a different drawing.
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(box.width / w, box.height / h, 1)));
  pan = { x: x0, y: y0 };
  applyView();
}

// ── Pictures ───────────────────────────────────────────────────────────────

/**
 * How big a picture arrives.
 *
 * Scaled down to fit a long edge and never up: a screenshot dropped on a canvas
 * should be readable, and a thumbnail blown up to match it would be a blurred
 * rectangle. The app's own number, so a picture is the same size in both.
 */
const IMAGE_LONG_EDGE = 380;

function imageSize(w, h) {
  const longest = Math.max(w, h, 1);
  const scale = Math.min(1, IMAGE_LONG_EDGE / longest);
  return { w: Math.max(Math.round(w * scale), 24), h: Math.max(Math.round(h * scale), 24) };
}

/** The picture's own dimensions, which only the browser can measure. */
const measure = (blob) =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });

async function addImage(blob, where) {
  const dims = await measure(blob);
  if (!dims) {
    say("that file isn't a picture this can read");
    return;
  }
  let name;
  try {
    const res = await fetch("/canvas/image", {
      method: "POST",
      headers: { "content-type": blob.type },
      body: blob,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.status);
    ({ name } = await res.json());
  } catch (err) {
    say(`couldn't keep the picture — ${err.message}`);
    return;
  }
  // Written only once the bytes are safely kept. A node pointing at a file that
  // failed to save is a grey box on every future opening of this canvas.
  const size = imageSize(dims.w, dims.h);
  const item = {
    id: newId(),
    x: Math.round(where.x - size.w / 2),
    y: Math.round(where.y - size.h / 2),
    w: size.w,
    h: size.h,
    text: "",
    shape: "plain",
    image: name,
  };
  doc.items.push(item);
  selected = { kind: "items", ids: [item.id] };
  draw();
  save();
}

const imagesIn = (list) =>
  [...(list ?? [])].filter((f) => f && typeof f.type === "string" && f.type.startsWith("image/"));

window.addEventListener("paste", (e) => {
  if (editing) return;
  const files = imagesIn([...(e.clipboardData?.items ?? [])].map((i) => i.getAsFile?.()));
  if (!files.length) return;
  e.preventDefault();
  // Where the last press was, not the pointer: a paste has no position of its
  // own, and the middle of the view is a guess about where somebody is looking.
  for (const f of files) void addImage(f, lastPoint);
});

surface.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

surface.addEventListener("drop", (e) => {
  const files = imagesIn(e.dataTransfer?.files);
  if (!files.length) return;
  e.preventDefault();
  const p = local(e);
  for (const f of files) void addImage(f, p);
});

// ── Inspector wiring ───────────────────────────────────────────────────────

for (const field of ["shape", "fill", "textColor", "stroke", "strokeStyle"]) {
  document.getElementById(`i-${field}`)?.addEventListener("change", (e) => apply(field, e.target.value));
}
// Weight on `input` rather than `change`: dragging a number up is a thing you
// watch happen, and waiting for the field to be left to see it is not that.
document.getElementById("i-strokeWidth")?.addEventListener("input", (e) => {
  const n = Number(e.target.value);
  if (Number.isFinite(n)) apply("strokeWidth", n);
});
for (const b of inspectorEl.querySelectorAll("[data-clear]")) {
  // Null, not a colour. A colour input always has one, so "none" needs its own
  // control — and a fill of none is how everything but a sticky starts.
  b.addEventListener("click", () => apply(b.dataset.clear, null));
}
// The panel is over the canvas, and a press on the canvas clears the selection.
// Without this, reaching for a control would deselect the thing it changes.
inspectorEl.addEventListener("pointerdown", (e) => e.stopPropagation());

// ── Reading ────────────────────────────────────────────────────────────────

async function load() {
  try {
    const res = await fetch("/canvas/document");
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const body = await res.json();
    doc = body.data ?? body;
    doc.items ??= [];
    doc.links ??= [];
    doc.regions ??= [];
    draw();
    // Opening on a canvas whose contents are somewhere off to the left is
    // opening on an empty page, so the first view is whatever shows all of it.
    fit();
    // After the first draw rather than before it: the canvas should be on
    // screen while Hermes is being asked, not after.
    await loadLinked();
    draw();
  } catch (err) {
    say(`couldn't read the canvas — ${err.message}`);
  }
}

load();
