/**
 * Reading the canvas and drawing it.
 *
 * Requests are relative, which is the whole point of the custom scheme: this
 * page has no idea it is talking to a Unix socket, and the same file will work
 * unchanged on Linux behind a WebKitGTK scheme handler.
 */

const surface = document.getElementById("surface");
const edges = document.getElementById("edges");
const status = document.getElementById("status");

/** Where a shape's outline goes, in the same words the document uses. */
const CLIP = {
  ellipse: "ellipse(50% 50% at 50% 50%)",
  triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
  postIt: "polygon(0 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%)",
};

/** The defaults the app applies when nobody has said. Mirrors `shapeDefaults`. */
const DEFAULT_FILL = { postIt: "#fdf3b6" };

function draw(doc) {
  for (const el of surface.querySelectorAll(".node")) el.remove();
  edges.innerHTML = "";

  // The document's coordinates can be negative — the canvas grows in every
  // direction from wherever somebody started — so everything is offset by the
  // top-left of what actually exists rather than by the origin.
  const xs = doc.items.map((i) => i.x);
  const ys = doc.items.map((i) => i.y);
  const ox = xs.length ? Math.min(...xs) - 40 : 0;
  const oy = ys.length ? Math.min(...ys) - 40 : 0;
  const at = (i) => ({ x: i.x - ox, y: i.y - oy });
  const centre = (i) => ({ x: i.x - ox + i.w / 2, y: i.y - oy + i.h / 2 });
  const byId = new Map(doc.items.map((i) => [i.id, i]));

  for (const link of doc.links) {
    const a = byId.get(link.from);
    const b = byId.get(link.to);
    if (!a || !b) continue;
    const p = centre(a);
    const q = centre(b);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // The bend is stored as an offset from the midpoint, and a cubic whose two
    // controls sit there passes through it — the same curve the app draws.
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

  for (const item of doc.items) {
    const el = document.createElement("div");
    el.className = "node";
    const { x, y } = at(item);
    Object.assign(el.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${item.w}px`,
      height: `${item.h}px`,
      background: item.fill ?? DEFAULT_FILL[item.shape] ?? "transparent",
      color: item.textColor ?? "inherit",
      justifyContent: { leading: "flex-start", trailing: "flex-end" }[item.hAlign] ?? "center",
      alignItems: { top: "flex-start", bottom: "flex-end" }[item.vAlign] ?? "center",
      textAlign: item.hAlign === "leading" ? "left" : item.hAlign === "trailing" ? "right" : "center",
    });
    const weight = item.strokeWidth ?? 1.5;
    if (item.shape && item.shape !== "plain") {
      if (CLIP[item.shape]) el.style.clipPath = CLIP[item.shape];
      if (item.shape === "roundedRectangle") el.style.borderRadius = "14px";
      // A clipped shape cannot also carry a border — the clip cuts it off — so
      // only the rectangles get one. Faithful outlines are stage three's job;
      // this is here to show the shapes are arriving, not to finish them.
      if (weight > 0 && !CLIP[item.shape]) {
        el.style.border = `${weight}px ${item.strokeStyle === "solid" ? "solid" : item.strokeStyle} ${item.stroke ?? "currentColor"}`;
      }
    }
    if (item.image) {
      const img = document.createElement("img");
      img.src = `/canvas/image/${encodeURIComponent(item.image)}`;
      img.alt = item.text || "";
      el.append(img);
    } else {
      el.textContent = item.text ?? "";
    }
    surface.append(el);
  }

  const pictures = doc.items.filter((i) => i.image).length;
  status.textContent =
    `${doc.items.length} nodes · ${doc.links.length} links · ${doc.regions.length} regions` +
    (pictures ? ` · ${pictures} picture${pictures === 1 ? "" : "s"}` : "");
}

async function load() {
  try {
    const res = await fetch("/canvas/document");
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const body = await res.json();
    // The daemon wraps replies in an envelope; the canvas is under `data`.
    draw(body.data ?? body);
  } catch (err) {
    status.textContent = `couldn't read the canvas — ${err.message}`;
  }
}

load();
