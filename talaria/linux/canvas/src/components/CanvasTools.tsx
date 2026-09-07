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
import { FileText, Image as ImageIcon, Search, SquareDashed, Type } from "lucide-react";
import { ask, document_, keep, keepResized, pictureAt } from "../api.ts";
import { putDocument, type CanvasItem } from "../document.ts";

/** The six the format has, in the Mac's order. */
/*
 * The shapes, in the renderer's own names.
 *
 * This list used to carry `roundedRectangle` and `plain`, and `CanvasView` has
 * never heard of either: its vocabulary is an absent shape for the rounded
 * default, then `rectangle`, `ellipse`, `triangle` and `postIt`. A node dropped
 * as a "roundedRectangle" matched no rule at all and fell through to the sticky
 * styling underneath — which is how choosing Rounded produced a post-it.
 *
 * `""` is the absent one. It is stored as `null`, because that is what the
 * document says and what every reader of it expects.
 */
const SHAPES: { key: string; name: string }[] = [
  // Words on the canvas and nothing else. It is a real value in the document —
  // a picture is placed as one, meaning no paper behind and no line around —
  // and it differs from the rounded default only in wearing no border, which is
  // what `defaults` gives it.
  { key: "plain", name: "Plain text" },
  { key: "", name: "Rounded" },
  { key: "rectangle", name: "Rectangle" },
  { key: "ellipse", name: "Ellipse" },
  { key: "triangle", name: "Triangle" },
  { key: "postIt", name: "Post-it" },
];

/** A small drawing of a shape, for the button that will drop it. */
function ShapeMark({ shape }: { shape: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6 } as const;
  // Plain text wears the letter it is, which is also the glyph this button had
  // before it started showing shapes.
  if (shape === "plain") return <Type size={15} />;
  if (shape === "ellipse") return <svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6" {...common} /></svg>;
  if (shape === "triangle") return <svg viewBox="0 0 16 16" width="15" height="15"><path d="M8 2.2 14 13.4H2z" {...common} strokeLinejoin="round" /></svg>;
  if (shape === "rectangle") return <svg viewBox="0 0 16 16" width="15" height="15"><rect x="2" y="3" width="12" height="10" {...common} /></svg>;
  if (shape === "postIt") {
    return (
      <svg viewBox="0 0 16 16" width="15" height="15">
        <path d="M2.5 3h11v6.5L10 13H2.5z" {...common} strokeLinejoin="round" />
        <path d="M13.5 9.5H10V13" {...common} strokeLinejoin="round" />
      </svg>
    );
  }
  return <svg viewBox="0 0 16 16" width="15" height="15"><rect x="2" y="3" width="12" height="10" rx="3" {...common} /></svg>;
}

/** What the daemon gives a shape when nobody has said otherwise. */
function defaults(shape: string): { fill: string | null; strokeWidth: number } {
  if (shape === "postIt") return { fill: "#fdf3b6", strokeWidth: 0 };
  // Zero is not the same as unset here — `borderOf` reads an explicit zero as
  // "no border" and an absent one as "whatever the stylesheet says". Plain text
  // means the first.
  if (shape === "plain") return { fill: null, strokeWidth: 0 };
  return { fill: null, strokeWidth: 1.5 };
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
  /*
   * The Select tool: a mode rather than an action.
   *
   * The Mac calls it "a mode tool that is currently on" and leaves it on until
   * it is turned off, which is what makes it worth having — arming it once and
   * sweeping three groups is the gesture; a tool that disarmed itself after one
   * would be a worse shift key.
   *
   * The flag lives on the root because the canvas is a sibling of this strip,
   * not a child of it, and a dataset attribute is the one channel both can see
   * without either owning the other.
   */
  const [selecting, setSelecting] = useState(false);
  useEffect(() => {
    if (selecting) window.document.documentElement.dataset.select = "on";
    else delete window.document.documentElement.dataset.select;
  }, [selecting]);
  useEffect(() => {
    const off = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelecting(false);
    };
    addEventListener("keydown", off);
    return () => removeEventListener("keydown", off);
  }, []);
  const loader = useRef<HTMLInputElement>(null);
  const picture = useRef<HTMLInputElement>(null);

  /** Write one item into the document and tell the page to read it again. */
  async function place(item: CanvasItem) {
    const doc = document_();
    doc.items = [...doc.items, item];
    await putDocument(doc);
    onPlaced();
  }

  /*
   * A double-click on bare canvas drops one too, in whatever shape is selected.
   *
   * Asked for rather than duplicated. The canvas is a sibling of this strip and
   * neither owns the other — the same standing the Select mode has, which uses a
   * dataset flag on the root for exactly that reason. An event is the same idea
   * pointed the other way: the canvas says where, and the strip, which is the
   * thing that knows what a new node is, makes it. Copying `defaults` over there
   * would have been a second answer to that question, free to drift.
   */
  useEffect(() => {
    const drop = (e: Event) => {
      const at = (e as CustomEvent<{ x: number; y: number }>).detail;
      if (at) dropText(at.x, at.y);
    };
    window.document.addEventListener("talaria-drop-text", drop);
    return () => window.document.removeEventListener("talaria-drop-text", drop);
  });

  function dropText(clientX: number, clientY: number) {
    const at = atPoint(clientX, clientY);
    const { fill, strokeWidth } = defaults(shape);
    void place({
      id: id(),
      x: at.x - 110, y: at.y - 65, w: 220, h: 130,
      // The rounded default is an *absent* key, not a value — `canvas.json` says
      // so and `document.ts` reads it that way. Writing a name for the default
      // would put a shape in the file that nothing there has ever meant.
      text: "", ...(shape ? { shape } : {}), fill, strokeWidth,
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

  /**
   * A picture, small enough to be one node among many.
   *
   * Resized before it is kept, to the Mac's own long edge: 380 is "big enough to
   * see, small enough that a screenshot of a whole display does not become the
   * canvas". It also has to fit down the only road there is — the body rides in
   * a header capped at 96 KB — so the quality steps down until it does, rather
   * than failing at the last moment on a picture somebody has already chosen.
   */
  /** The tool's own way in; the same road a paste takes. */
  async function addPicture(file: File) {
    const kept = await keepResized(file);
    const middle = window.document.querySelector(".cv-wrap")?.getBoundingClientRect();
    const at = atPoint((middle?.width ?? 900) / 2, (middle?.height ?? 600) / 2);
    await place({
      id: id(),
      x: at.x - Math.round(kept.w / 2), y: at.y - Math.round(kept.h / 2), w: kept.w, h: kept.h,
      image: kept.name, images: [kept.name], showImage: true,
      // A picture is the node. No paper behind it and no line around it — the
      // photograph has its own edges.
      shape: "plain", fill: null, strokeWidth: 0,
    });
  }

  /** Ask the shell for a picture of this canvas. */
  function exportAs(kind: "png" | "pdf") {
    setFileOpen(false);
    // Fire and forget: the shell answers at once and does the work behind a file
    // dialog, so nothing here waits on a modal window somebody is typing into.
    void ask("GET", `/shell/export?kind=${kind}`).catch(() => {});
  }

  /** One kept picture, as base64 — the shape a saved canvas carries. */
  function asBase64(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("GET", url, true);
      x.responseType = "blob";
      x.onload = () => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("unreadable"));
        reader.readAsDataURL(x.response as Blob);
      };
      x.onerror = () => reject(new Error("gone"));
      x.send(null);
    });
  }

  /**
   * This canvas, as one file somebody can keep.
   *
   * The counterpart of `load`, and it was never written — the menu item pointed
   * at a bare `save` that is not a function, not an import and not a global, so
   * clicking it threw. `vite build` does not typecheck, so nothing said so; a
   * `tsc --noEmit` names it in one line.
   *
   * The pictures travel inside the file rather than beside it. A canvas whose
   * images live in the daemon's store is a canvas that means nothing on another
   * machine, and `load` already expects them carried this way and renames them
   * on the way back in.
   */
  async function save() {
    setFileOpen(false);
    const doc = document_();
    if (!doc) return;

    const wanted = new Set<string>();
    for (const item of doc.items ?? []) {
      if (typeof item.image === "string") wanted.add(item.image);
      for (const name of item.images ?? []) wanted.add(name);
    }
    const images: Record<string, string> = {};
    for (const name of wanted) {
      try {
        images[name] = await asBase64(pictureAt(name));
      } catch {
        // A picture that will not read is not a reason to refuse the canvas.
        // `load` shows nothing for a name it cannot find, which is the same
        // answer arrived at from the other side.
      }
    }

    /*
     * Offered as a download, which is the one way a page can produce a file —
     * and the shell is waiting for it: `_save_as` puts up the Save dialog and
     * says in its own comment that "the canvas saves a document by offering it
     * as a download". That half has been built the whole time.
     */
    const blob = new Blob([JSON.stringify({ document: doc, images }, null, 2)],
                          { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = "canvas.json";
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    // Let the download start before the blob is let go of.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
    const doc = (read.document ?? read) as { items?: Record<string, unknown>[] };
    if (!Array.isArray(doc.items)) return;

    /*
     * The pictures are put back first, and under new names.
     *
     * A saved canvas carries its images by the name it knew them by; this
     * machine may already have a different file under that name, or none. So
     * each one is handed to the daemon again and the document is rewritten to
     * point at whatever it is called here. Loading a canvas from another machine
     * is then the same as loading one from this one.
     */
    const carried = (read as { images?: Record<string, string> }).images ?? {};
    const renamed: Record<string, string> = {};
    for (const [was, base64] of Object.entries(carried)) {
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const type = was.toLowerCase().endsWith(".png") ? "image/png"
          : was.toLowerCase().endsWith(".gif") ? "image/gif"
          : was.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
        renamed[was] = await keep(new Blob([bytes], { type }));
      } catch {
        // One picture that will not go back is not a reason to refuse the rest
        // of the canvas; the node keeps its name and shows nothing.
      }
    }
    if (Object.keys(renamed).length) {
      for (const item of doc.items) {
        if (typeof item.image === "string" && renamed[item.image]) item.image = renamed[item.image];
        if (Array.isArray(item.images)) {
          item.images = (item.images as string[]).map((n) => renamed[n] ?? n);
        }
      }
    }
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
        {/*
          * One button, and it is a picture of what it will drop.
          *
          * There were two: a `Type` glyph you dragged, and a chevron beside it
          * that opened the list. Which meant the tool never showed what it was
          * about to make, and the list was a second target the width of a
          * thumbnail. Now the button wears the shape — drag it to place one,
          * click it to choose a different one — and there is nothing to aim at
          * twice.
          */}
        {tool(
          "text",
          `Drag onto the canvas — ${SHAPES.find((s) => s.key === shape)?.name}`,
          <ShapeMark shape={shape} />,
          () => setShapesOpen((o) => !o),
        )}
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

      <button
        className={`tool${selecting ? " armed" : ""}`}
        title={selecting ? "Selecting — drag to sweep, Escape to stop" : "Select: drag to sweep without holding Shift"}
        onClick={() => setSelecting((on) => !on)}
      >
        <SquareDashed size={15} />
      </button>

      {tool("image", "A picture on the canvas", <ImageIcon size={15} />, () => picture.current?.click())}

      {tool("file", "Save or load this canvas", <FileText size={15} />, () => {
        setFileOpen((o) => !o);
        setFinding(false);
      })}
      {fileOpen && (
        <div className="tool-menu">
          <button className="menu-item" onClick={save}>Save…</button>
          <button className="menu-item" onClick={() => loader.current?.click()}>Load…</button>
          <div className="menu-sep" />
          {/*
            * Exporting is the shell's job, not this page's.
            *
            * A page cannot render itself to a PDF, cannot take its own picture
            * larger than its window, and cannot ask where to put a file. The
            * shell can: it opens this same canvas off-screen with `?export=1`,
            * sizes the window to the drawing and photographs it. So what comes
            * out is what you are looking at, drawn by the same code — the Mac
            * gets there by walking the items and drawing them again in Swift,
            * which is the one route not open to a canvas that lives in a
            * browser.
            */}
          <button className="menu-item" onClick={() => exportAs("png")}>Export PNG…</button>
          <button className="menu-item" onClick={() => exportAs("pdf")}>Export PDF…</button>
        </div>
      )}

      <input
        ref={picture}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void addPicture(file);
        }}
      />
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
