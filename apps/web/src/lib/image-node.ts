import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { apiBase } from "../api.ts";

/**
 * Inline image node for the markdown surfaces. Serializes as
 * `![alt|width](src)` (Obsidian-style width suffix), where src is either a
 * web URL or `attachment:<id>` — resolved to the attachments endpoint at
 * render time so saved markdown stays host-independent. The node view adds a
 * corner drag handle for resizing. Deleting the node never touches the
 * underlying attachment.
 */

export const resolveImageSrc = (src: string): string =>
  src.startsWith("attachment:") ? `${apiBase}/attachments/${src.slice(11)}` : src;

export const MdImage = Node.create({
  name: "mdImage",
  inline: true,
  group: "inline",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: "" },
      width: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (el) => {
          const img = el as HTMLImageElement;
          const rawAlt = img.getAttribute("alt") ?? "";
          const m = /^(.*)\|(\d+)$/.exec(rawAlt);
          return {
            src: img.getAttribute("src") ?? "",
            alt: m ? m[1] : rawAlt,
            width: m ? Number(m[2]) : null,
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(HTMLAttributes, {
        src: node.attrs.src,
        alt: node.attrs.alt,
        ...(node.attrs.width ? { width: node.attrs.width } : {}),
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (t: string) => void }, node: PMNode) {
          const alt = `${String(node.attrs.alt ?? "").replace(/[[\]]/g, "")}${
            node.attrs.width ? `|${node.attrs.width}` : ""
          }`;
          state.write(`![${alt}](${node.attrs.src})`);
        },
        parse: {},
      },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const wrap = document.createElement("span");
      wrap.className = "md-img";
      const img = document.createElement("img");
      const sync = (n: PMNode) => {
        img.src = resolveImageSrc(String(n.attrs.src ?? ""));
        img.alt = String(n.attrs.alt ?? "");
        img.style.width = n.attrs.width ? `${n.attrs.width}px` : "";
      };
      sync(node);
      const handle = document.createElement("span");
      handle.className = "md-img-handle";
      handle.title = "Drag to resize";
      handle.addEventListener("pointerdown", (e) => {
        if (!editor.isEditable) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = img.getBoundingClientRect().width;
        const onMove = (ev: PointerEvent) => {
          img.style.width = `${Math.max(48, Math.round(startW + ev.clientX - startX))}px`;
        };
        const onUp = (ev: PointerEvent) => {
          document.removeEventListener("pointermove", onMove);
          const w = Math.max(48, Math.round(startW + ev.clientX - startX));
          if (typeof getPos === "function") {
            const pos = getPos();
            editor.commands.command(({ tr }) => {
              const n = tr.doc.nodeAt(pos);
              if (n?.type.name === "mdImage") tr.setNodeMarkup(pos, undefined, { ...n.attrs, width: w });
              return true;
            });
          }
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp, { once: true });
      });
      wrap.append(img, handle);
      return {
        dom: wrap,
        update: (n) => {
          if (n.type.name !== "mdImage") return false;
          sync(n);
          return true;
        },
      };
    };
  },
});
