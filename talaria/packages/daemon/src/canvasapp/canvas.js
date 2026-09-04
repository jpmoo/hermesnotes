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
let selected = null;
let editing = null;
const nodes = new Map(); // item id → element

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

function summarize() {
  const pictures = doc.items.filter((i) => i.image).length;
  say(
    `${doc.items.length} nodes · ${doc.links.length} links · ${doc.regions.length} regions` +
      (pictures ? ` · ${pictures} picture${pictures === 1 ? "" : "s"}` : ""),
  );
}

// ── Drawing ────────────────────────────────────────────────────────────────

function drawLinks() {
  edges.innerHTML = "";
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  for (const link of doc.links) {
    const a = byId.get(link.from);
    const b = byId.get(link.to);
    if (!a || !b) continue;
    const p = centre(a);
    const q = centre(b);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // The bend is an offset from the midpoint, and a quadratic whose control
    // sits there passes through it — the curve the app draws.
    const mx = (p.x + q.x) / 2 + (link.bendX ?? 0);
    const my = (p.y + q.y) / 2 + (link.bendY ?? 0);
    line.setAttribute("d", `M ${p.x} ${p.y} Q ${mx} ${my} ${q.x} ${q.y}`);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", link.color ?? "currentColor");
    line.setAttribute("stroke-width", String(link.width ?? 1.5));
    if (link.style === "dashed") line.setAttribute("stroke-dasharray", "6 4");
    if (link.style === "dotted") line.setAttribute("stroke-dasharray", "1 4");
    edges.append(line);
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
  for (const [id, el] of nodes) el.classList.toggle("selected", id === selected);
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
  selected = item.id;
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
  if (selected === id) selected = null;
  drawLinks();
  save();
  summarize();
}

// ── Pointing ───────────────────────────────────────────────────────────────

let drag = null;

surface.addEventListener("pointerdown", (e) => {
  if (editing) return;
  const el = e.target.closest(".node");
  if (!el) {
    selected = null;
    showSelection();
    return;
  }
  selected = el.dataset.id;
  showSelection();
  const item = find(selected);
  if (!item) return;
  drag = { id: selected, startX: e.clientX, startY: e.clientY, ox: item.x, oy: item.y, moved: false };
  el.setPointerCapture(e.pointerId);
});

surface.addEventListener("pointermove", (e) => {
  if (!drag) return;
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
});

surface.addEventListener("pointerup", () => {
  // Saved on release, not on every frame of the drag: a canvas written a
  // hundred times crossing the screen is a hundred writes of the same fact.
  if (drag?.moved) save();
  drag = null;
});

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
    remove(selected);
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
