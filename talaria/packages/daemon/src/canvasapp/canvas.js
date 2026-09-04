/**
 * The canvas, read and changed.
 *
 * Requests are relative, which is the whole point of the custom scheme: this
 * page has no idea it is talking to a Unix socket, and the same file works
 * unchanged behind WebKitGTK on Linux.
 *
 * Stage three, first slice: nodes. Making one, moving it, writing in it,
 * removing it, and having all of that still be there next time. Links draw and
 * follow what moves but cannot yet be made here; regions, images, the
 * inspector, snapping and bends come in later slices. Everything the document
 * holds is preserved on write whether this page understands it or not — a
 * canvas edited here must not come back to the app with its regions gone.
 */

const surface = document.getElementById("surface");
const edges = document.getElementById("edges");
const status = document.getElementById("status");

const CLIP = {
  ellipse: "ellipse(50% 50% at 50% 50%)",
  triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
  postIt: "polygon(0 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%)",
};
const DEFAULT_FILL = { postIt: "#fdf3b6" };
const NEW_SIZE = { w: 140, h: 70 };

/** The document exactly as the daemon gave it, keys this page never reads and all. */
let doc = { items: [], links: [], regions: [] };
/**
 * Where the document's origin sits on screen. Fixed at load rather than derived
 * from the items each time: recomputing it would mean dragging the leftmost
 * node moved everything else, which reads as the canvas coming apart.
 */
let pan = { x: 0, y: 0 };
/** What is picked: `{ kind: "item" | "link", id }`, or nothing. */
let selected = null;
let editing = null;
const nodes = new Map(); // item id → element
const handleEl = document.getElementById("handle");

const at = (i) => ({ x: i.x - pan.x, y: i.y - pan.y });
const centre = (i) => ({ x: i.x - pan.x + i.w / 2, y: i.y - pan.y + i.h / 2 });

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

function geometry(link) {
  const from = doc.items.find((i) => i.id === link.from);
  const to = doc.items.find((i) => i.id === link.to);
  if (!from || !to) return null;
  const A = { x: from.x - pan.x, y: from.y - pan.y, w: from.w, h: from.h };
  const B = { x: to.x - pan.x, y: to.y - pan.y, w: to.w, h: to.h };
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
    const hit = svg("path", { d, fill: "none", stroke: "transparent", "stroke-width": 14 });
    hit.classList.add("hit");
    hit.dataset.link = link.id;
    edges.append(hit);

    const line = svg("path", {
      d,
      fill: "none",
      stroke: on ? "#5fa4b5" : color,
      "stroke-width": on ? Math.max(width, 2) : width,
    });
    if (link.style === "dashed") line.setAttribute("stroke-dasharray", "6 4");
    if (link.style === "dotted") line.setAttribute("stroke-dasharray", "1 4");
    edges.append(line);

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
      const grip = svg("circle", { cx: g.handle.x, cy: g.handle.y, r: 6 });
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
    el.textContent = item.text ?? "";
  }
  surface.append(el);
  nodes.set(item.id, el);
  return el;
}

function draw() {
  for (const el of nodes.values()) el.remove();
  nodes.clear();
  for (const item of doc.items) node(item);
  drawLinks();
  showSelection();
  summarize();
}

function showSelection() {
  for (const [id, el] of nodes)
    el.classList.toggle("selected", selected?.kind === "item" && selected.id === id);
  // Lines are redrawn rather than restyled: which one is picked changes its
  // color, its weight, and whether it carries a grip, and rebuilding four
  // shapes is less code than keeping three of them in step.
  drawLinks();
  showHandle();
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
  if (selected?.kind !== "item") return;
  const item = find(selected.id);
  if (!item) return;
  const { x, y } = at(item);
  handleEl.style.left = `${x + item.w}px`;
  handleEl.style.top = `${y + item.h / 2}px`;
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
    x: Math.round(x + pan.x - NEW_SIZE.w / 2),
    y: Math.round(y + pan.y - NEW_SIZE.h / 2),
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
  selected = { kind: "item", id: item.id };
  showSelection();
  edit(item.id);
}

function remove(id) {
  doc.items = doc.items.filter((i) => i.id !== id);
  // A line with only one end left cannot be drawn and must not be kept — it
  // would be written back out and outlive any chance of meaning anything.
  doc.links = doc.links.filter((l) => l.from !== id && l.to !== id);
  // A region keeps the members still here; one holding nothing is over.
  doc.regions = doc.regions
    .map((r) => ({ ...r, members: (r.members ?? []).filter((m) => m !== id) }))
    .filter((r) => (r.members ?? []).length > 0);
  nodes.get(id)?.remove();
  nodes.delete(id);
  if (selected?.kind === "item" && selected.id === id) selected = null;
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

// ── Pointing ───────────────────────────────────────────────────────────────

/** A move, a bend, or a line being drawn — whichever the hand is doing. */
let drag = null;
/** The line drawn while connecting, which is not in the document yet. */
let ghost = null;

/** Where the pointer is, in the surface's own coordinates. */
function local(e) {
  const box = surface.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
}

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
  const p = local(e);

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
  if (e.target === handleEl && selected?.kind === "item") {
    drag = { what: "connect", from: selected.id, to: p, moved: false };
    surface.setPointerCapture?.(e.pointerId);
    return;
  }

  const el = e.target.closest?.(".node");
  if (el) {
    selected = { kind: "item", id: el.dataset.id };
    showSelection();
    const item = find(el.dataset.id);
    if (!item) return;
    drag = { what: "move", id: item.id, startX: e.clientX, startY: e.clientY, ox: item.x, oy: item.y, moved: false };
    el.setPointerCapture(e.pointerId);
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
  selected = nearest ? { kind: "link", id: nearest.id } : null;
  showSelection();
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

  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
  drag.moved = true;
  const item = find(drag.id);
  if (!item) return;
  item.x = Math.round(drag.ox + dx);
  item.y = Math.round(drag.oy + dy);
  place(nodes.get(drag.id), item);
  // Lines follow what they are tied to while it moves, rather than snapping
  // into place when the hand comes off.
  drawLinks();
  showHandle();
});

surface.addEventListener("pointerup", (e) => {
  if (drag?.what === "connect") {
    clearGhost();
    const target = nodeAt(local(e));
    if (target) link(drag.from, target.id);
  } else if (drag?.moved) {
    // Saved on release, not on every frame: a canvas written a hundred times
    // crossing the screen is a hundred writes of the same fact.
    save();
  }
  drag = null;
});

/** The line being drawn, before there is anything to draw it from. */
function drawGhost(d) {
  const from = find(d.from);
  if (!from) return;
  const a = nearestSide({ x: from.x - pan.x, y: from.y - pan.y, w: from.w, h: from.h }, d.to);
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
  const el = e.target.closest(".node");
  if (el) {
    edit(el.dataset.id);
    return;
  }
  const box = surface.getBoundingClientRect();
  create(e.clientX - box.left, e.clientY - box.top);
});

window.addEventListener("keydown", (e) => {
  if (editing) {
    // Escape gives the node back its focus-out, which is what commits.
    if (e.key === "Escape") nodes.get(editing)?.blur();
    return;
  }
  if ((e.key === "Backspace" || e.key === "Delete") && selected) {
    if (selected.kind === "link") removeLink(selected.id);
    else remove(selected.id);
    e.preventDefault();
  }
});

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
    const xs = doc.items.map((i) => i.x);
    const ys = doc.items.map((i) => i.y);
    pan = { x: xs.length ? Math.min(...xs) - 40 : 0, y: ys.length ? Math.min(...ys) - 40 : 0 };
    draw();
  } catch (err) {
    say(`couldn't read the canvas — ${err.message}`);
  }
}

load();
