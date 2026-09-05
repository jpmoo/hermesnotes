/*
 * A long-text field, as Hermes writes one.
 *
 * Hermes' editor renders every block except the one the caret is in, which
 * shows its raw markdown — `apps/web/src/lib/active-line-source.ts` builds that
 * out of a ProseMirror node whose text "serializes VERBATIM … so having one in
 * the document can never corrupt the saved markdown." That sentence is the
 * whole design, and it is reachable without ProseMirror: keep the markdown, cut
 * it into blocks, render all of them, and swap the one being edited for a
 * textarea holding exactly its source.
 *
 * **Round-trip is by construction, not by care.** Each block keeps the
 * whitespace that followed it, so the document is `blocks.map(b => b.src +
 * b.sep).join("")` and an untouched note is returned byte for byte. This is the
 * same promise the interchange importer makes about unknown fields, for the
 * same reason: a thing that rewrites what it did not understand is not safe to
 * leave running on somebody's notes.
 *
 * What it does, then: live rendering, `@`/`#`/`|` pickers inserting markdown
 * links, checkboxes you can tick, and links that go somewhere.
 */
import { render } from "/ui/markdown.js";
import { mentions } from "/ui/mentions.js";
import { el } from "/ui/api.js";

/**
 * The document, in blocks.
 *
 * Blank lines separate blocks, which is markdown's own rule, with one
 * exception: a fenced code block is one block however many blank lines are
 * inside it. Tables and lists need no exception — their lines are consecutive.
 */
export function split(text) {
  const src = String(text ?? "");
  const lines = src.split("\n");

  /*
   * Separators are *cut from the original text*, never rebuilt from a count.
   *
   * Two versions counted blank lines and both were wrong at the edges, for the
   * same reason: `"a\n".split("\n")` is `["a", ""]` and that last element is
   * not a blank line, it is the final newline wearing one's clothes — while
   * `"".split("\n")` is `[""]` and stands for no newline at all. Slicing the
   * source between the end of one block and the start of the next cannot get
   * that wrong, because it never has to decide what an element means.
   */
  const at = [0];
  for (const line of lines) at.push(at[at.length - 1] + line.length + 1);

  // Blank means blank, unless it is inside a fence, where it is code.
  const blank = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    blank.push(!fenced && !line.trim());
  }

  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    if (blank[i]) continue;
    const from = i;
    while (i + 1 < lines.length && !blank[i + 1]) i += 1;
    runs.push([from, i]);
  }

  const blocks = [];
  // Anything before the first block — blank lines somebody left at the top —
  // is held by a block with no source. It draws nothing and rejoins exactly.
  if (runs.length && at[runs[0][0]] > 0) blocks.push({ src: "", sep: src.slice(0, at[runs[0][0]]) });
  if (!runs.length) return src ? [{ src: "", sep: src }] : [];

  for (const [i, [from, to]] of runs.entries()) {
    const ends = at[to] + lines[to].length;
    const next = runs[i + 1] ? at[runs[i + 1][0]] : src.length;
    blocks.push({ src: lines.slice(from, to + 1).join("\n"), sep: src.slice(ends, next) });
  }
  return blocks;
}

export const joined = (blocks) => blocks.map((b) => b.src + b.sep).join("");

/**
 * Build the field.
 *
 * `onChange` is handed the whole document whenever it changes and is expected
 * to decide when to write it; this knows nothing about versions or endpoints.
 */
export function noteField(host, text, onChange) {
  let blocks = split(text);
  let editing = null;
  const view = el("div", "note-field");
  host.replaceChildren(view);

  const changed = () => onChange(joined(blocks));

  function draw() {
    view.replaceChildren();
    for (const [i, blockOf] of blocks.entries()) {
      if (i === editing) { view.appendChild(source(i)); continue; }
      // A placeholder for leading blank lines has nothing to show. It keeps its
      // place in the array so every other index still means what it meant.
      if (!blockOf.src) continue;
      view.appendChild(rendered(i, blockOf));
    }
    if (!blocks.length) {
      // An empty note still needs somewhere to click, or the only way into it
      // is a keyboard shortcut nobody was told about.
      const invitation = el("div", "note-block note-empty", "Write something…");
      invitation.onclick = () => { blocks = [{ src: "", sep: "" }]; editing = 0; draw(); };
      view.appendChild(invitation);
    }
  }

  /** One rendered block, with its checkboxes live and its links clickable. */
  function rendered(i, blockOf) {
    const node = el("div", "note-block");
    node.appendChild(render(blockOf.src));

    for (const box of node.querySelectorAll('input[type="checkbox"]')) {
      box.disabled = false;
      box.addEventListener("mousedown", (e) => e.stopPropagation());
      box.addEventListener("change", () => {
        // The line index is the block's own, because the block was rendered
        // alone. Rewriting that one line leaves everything else — indentation,
        // trailing notes, a link in the text — exactly as it was.
        const lines = blockOf.src.split("\n");
        const at = Number(box.dataset.line);
        lines[at] = lines[at].replace(/\[([ xX])\]/, box.checked ? "[x]" : "[ ]");
        blocks[i] = { ...blockOf, src: lines.join("\n") };
        changed();
        draw();
      });
    }

    node.addEventListener("click", (e) => {
      const link = e.target.closest("a");
      if (link) return;                     // handled by the page — see `links`
      if (e.target.closest("input")) return;
      editing = i;
      draw();
    });
    return node;
  }

  /** The block being edited: its markdown, exactly as it is stored. */
  function source(i) {
    const box = el("div", "note-source");
    const field = document.createElement("textarea");
    field.value = blocks[i].src;
    field.spellcheck = false;
    box.appendChild(field);

    const picker = mentions(field, box);

    const grow = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    };
    field.addEventListener("input", () => {
      blocks[i] = { ...blocks[i], src: field.value };
      grow();
      changed();
    });

    field.addEventListener("keydown", (e) => {
      // The picker gets first refusal on every key it cares about — arrows,
      // Enter, Escape all mean something to an open dropdown and something else
      // to the text underneath it.
      if (picker.keydown(e)) return e.preventDefault();
      if (e.key === "Escape") { field.blur(); return; }
      // Leaving the block by arrow at its edge, which is how a document made of
      // separate editors still feels like one document.
      const atStart = field.selectionStart === 0 && field.selectionEnd === 0;
      const atEnd = field.selectionStart === field.value.length;
      if (e.key === "ArrowUp" && atStart && i > 0) { e.preventDefault(); editing = i - 1; draw(); }
      if (e.key === "ArrowDown" && atEnd && i < blocks.length - 1) {
        e.preventDefault(); editing = i + 1; draw();
      }
    });

    field.addEventListener("blur", () => {
      // A blur into the picker is not a blur out of the block.
      setTimeout(() => {
        if (picker.open || document.activeElement === field) return;
        // An emptied block goes, rather than leaving a gap that has to be
        // deleted twice.
        if (!blocks[i].src.trim()) {
          blocks.splice(i, 1);
          changed();
        } else {
          // Typed a blank line into the middle of a block: that is two blocks
          // now, and re-splitting is how it becomes them.
          const again = split(joined(blocks));
          if (again.length !== blocks.length) blocks = again;
        }
        editing = null;
        draw();
      }, 0);
    });

    queueMicrotask(() => { field.focus(); grow(); field.setSelectionRange(field.value.length, field.value.length); });
    return box;
  }

  draw();
  return {
    get text() { return joined(blocks); },
    /** Replace the contents — for a note that changed under us. */
    set(next) { blocks = split(next); editing = null; draw(); },
  };
}
