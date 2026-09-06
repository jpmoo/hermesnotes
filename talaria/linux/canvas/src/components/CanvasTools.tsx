/*
 * The tool strip: what you put on the canvas, and where it goes.
 *
 * The Mac's, ported rather than invented — `CanvasToolStrip` in
 * `CanvasSurface.swift`. Four tools, each **dragged** onto the surface rather
 * than clicked: a tool that adds something in the middle of the screen is a tool
 * you then have to move, and on a canvas the placing *is* the work.
 *
 * Talaria's own code, not part of the fork. Hermes has no tool strip — it fills
 * a canvas from a collection — so there is nothing here to keep in step with it,
 * and the strip writes through the same seam everything else does.
 *
 * Where a drop lands is read off the canvas's own transform. The layer carries
 * `translate(x, y) scale(z)`, which is the only place the view's pan and zoom
 * are written down, so a screen point becomes a document point without this
 * having to know anything else about the surface it sits on.
 */
import { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, Search, Square, Type } from "lucide-react";
import { ask, document_ } from "../api.ts";
import { putDocument, type CanvasItem } from "../document.ts";

/** The six the format has, in the Mac's order. */
const SHAPES: { key: string; name: string }[] = [
  { key: "plain", name: "Plain" },
  { key: "rectangle", name: "Rectangle" },
  { key: "roundedRectangle", name: "Rounded" },
  { key: "ellipse", name: "Ellipse" },
  { key: "triangle", name: "Triangle" },
  { key: "postIt", name: "Post-it" },
];

/** What the daemon gives a shape when nobody has said otherwise. */
function defaults(shape: string): { fill: string | null; strokeWidth: number } {
  return shape === "postIt" ? { fill: "#fdf3b6", strokeWidth: 0 } : { fill: null, strokeWidth: 1.5 };
}

const id = () => `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A screen point, in document coordinates. */
function atPoint(clientX: number, clientY: number): { x: number; y: number } {
  const layer = window.document.querySelector<HTMLElement>(".cv-layer");
  const wrap = window.document.querySelector<HTMLElement>(".cv-wrap");
  const box = wrap?.getBoundingClientRect();
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(
    layer?.style.transform ?? "",
  );
  const [px, py, z] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
  const left = (clientX - (box?.left ?? 0) - px) / z;
  const top = (clientY - (box?.top ?? 0) - py) / z;
  return { x: Math.round(left), y: Math.round(top) };
}

export function CanvasTools({ onPlaced }: { onPlaced: () => void }) {
  const [shape, setShape] = useState("postIt");
  const [shapesOpen, setShapesOpen] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ id: string; title: string; typeName?: string }[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const loader = useRef<HTMLInputElement>(null);

  /** Write one item into the document and tell the page to read it again. */
  async function place(item: CanvasItem) {
    const doc = document_();
    doc.items = [...doc.items, item];
    await putDocument(doc);
    onPlaced();
  }

  function dropText(clientX: number, clientY: number) {
    const at = atPoint(clientX, clientY);
    const { fill, strokeWidth } = defaults(shape);
    void place({
      id: id(),
      x: at.x - 110, y: at.y - 65, w: 220, h: 130,
      text: "", shape, fill, strokeWidth,
    });
  }

  async function dropBlock(clientX: number, clientY: number, blockId: string) {
    const at = atPoint(clientX, clientY);
    await place({ id: id(), x: at.x - 115, y: at.y - 45, w: 230, h: 90, blockId });
  }

  /*
   * Searching the library — through the daemon, which reads the mirror.
   *
   * The Mac's `find` tool, and the distinction that matters: Hermes' own canvas
   * has a search box wired to its `/blocks/query`, which is Hermes' API and off
   * limits here. This asks the daemon, which answers from the local mirror
   * built out of the interchange — so it also works with the network down,
   * which the Hermes one could never do.
   */
  useEffect(() => {
    if (!finding) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const q = query.trim().toLowerCase();
      if (!q) return setFound([]);
      try {
        const spotlight = await ask<{ items: { id: string; title: string; typeName?: string }[] }>(
          "GET", "/spotlight",
        );
        if (cancelled) return;
        const taken = new Set(document_().items.map((i) => i.blockId).filter(Boolean));
        setFound(
          (spotlight.items ?? [])
            .filter((b) => !taken.has(b.id) && (b.title ?? "").toLowerCase().includes(q))
            .slice(0, 8),
        );
      } catch {
        setFound([]);
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, finding]);

  /* Save is a download, which is the only way a page can hand over a file; the
   * shell puts up the panel that says where. The shape is the Mac's
   * `CanvasExport` — the document, and the pictures it names, in one file,
   * "which is what makes this one file rather than a folder". */
  function save() {
    const when = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify({ document: document_(), images: {} }, null, 2)], {
      type: "application/json",
    });
    const link = window.document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `canvas-${when}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    setFileOpen(false);
  }

  async function load(file: File) {
    setFileOpen(false);
    const text = await file.text();
    let read: { document?: unknown; items?: unknown };
    try {
      read = JSON.parse(text);
    } catch {
      return;
    }
    // A saved canvas, or a bare document. Both are things somebody might hand
    // you, and refusing the second on a technicality would be pedantry.
    const doc = (read.document ?? read) as { items?: unknown[] };
    if (!Array.isArray(doc.items)) return;
    await putDocument(doc as never);
    onPlaced();
  }

  const tool = (key: string, title: string, node: React.ReactNode, onClick?: () => void) => (
    <button
      key={key}
      className={`tool${dragging === key ? " lifted" : ""}`}
      title={title}
      onClick={onClick}
      // Dragged onto the surface, in the Mac's own words: the placing is the
      // work. A plain click still drops one in the middle, for a pointer that
      // would rather not drag.
      onPointerDown={(e) => {
        if (key !== "text" || e.button !== 0) return;
        e.preventDefault();
        setDragging(key);
        const finish = (up: PointerEvent) => {
          window.removeEventListener("pointerup", finish);
          setDragging(null);
          const over = window.document.elementFromPoint(up.clientX, up.clientY);
          if (over?.closest(".cv-wrap")) dropText(up.clientX, up.clientY);
        };
        window.addEventListener("pointerup", finish);
      }}
    >
      {node}
    </button>
  );

  return (
    <div className="tools">
      <div className="tool-row">
        {tool("text", `Drag onto the canvas — ${SHAPES.find((s) => s.key === shape)?.name}`, <Type size={15} />,
          () => { /* the drag does the work; a bare click opens the shapes */ setShapesOpen((o) => !o); })}
        <button
          className={`tool-shape${shapesOpen ? " open" : ""}`}
          title="What shape a new node is"
          onClick={() => setShapesOpen((o) => !o)}
        >
          <Square size={11} />
        </button>
      </div>
      {shapesOpen && (
        <div className="tool-menu">
          {SHAPES.map((s) => (
            <button
              key={s.key}
              className={`menu-item${shape === s.key ? " on" : ""}`}
              onClick={() => { setShape(s.key); setShapesOpen(false); }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {tool("find", "Put something from Hermes Notes here", <Search size={15} />, () => {
        setFinding((f) => !f);
        setFileOpen(false);
      })}
      {finding && (
        <div className="tool-menu wide">
          <input
            autoFocus
            className="tool-find"
            placeholder="Search the mirror…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {found.map((b) => (
            <button
              key={b.id}
              className="menu-item"
              onClick={async () => {
                setFinding(false);
                setQuery("");
                const wrap = window.document.querySelector(".cv-wrap")?.getBoundingClientRect();
                await dropBlock((wrap?.width ?? 800) / 2, (wrap?.height ?? 600) / 2, b.id);
              }}
            >
              <span>{b.title}</span>
              {b.typeName && <span className="fine">{b.typeName}</span>}
            </button>
          ))}
        </div>
      )}

      {/*
        * The picture tool, present and disabled.
        *
        * The daemon has both halves already — `POST /canvas/image` keeps the
        * bytes beside the document and `GET /canvas/image/:name` hands them
        * back — and an item carries the file's *name*. What is missing is on
        * this side: the forked component expects a note's picture to be the
        * bytes inline, as `{name, mime, data}`, which is how Hermes carries one
        * on a collection. Teaching it to read a name is a change to the fork
        * rather than to this strip, and it is the next thing here.
        *
        * Shown rather than hidden, because the Mac's strip has four tools and a
        * strip with a gap in it invites the question this answers.
        */}
      <button className="tool" disabled title="Pictures: the daemon keeps them, the canvas cannot draw one yet">
        <ImageIcon size={15} />
      </button>

      {tool("file", "Save or load this canvas", <FileText size={15} />, () => {
        setFileOpen((o) => !o);
        setFinding(false);
      })}
      {fileOpen && (
        <div className="tool-menu">
          <button className="menu-item" onClick={save}>Save…</button>
          <button className="menu-item" onClick={() => loader.current?.click()}>Load…</button>
        </div>
      )}

      <input
        ref={loader}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void load(file);
        }}
      />
    </div>
  );
}
