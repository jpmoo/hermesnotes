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
  //: Where the caret goes when the next block opens. Null means "at the end",
  //: which is right for clicking into something and for a block Enter just
  //: created empty.
  let landing = null;
  //: The textarea that is open right now, held by identity rather than by
  //: index — see the blur handler, where the difference is the whole bug.
  let active = null;
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
  /*
   * What Enter does, which is not "insert a newline".
   *
   * A block editor where Enter only made the textarea taller is one block with
   * the whole day in it — the rendering never comes back and the model is a
   * textarea wearing a costume. Three cases, and they are the ones every
   * markdown editor has:
   *
   * - **In a list, continue the list.** Consecutive list lines are one block,
   *   so this is a newline plus the same marker — and a task line continues as
   *   an unticked task, because a list of things to do is usually more than one
   *   thing to do.
   * - **On an empty list item, end the list.** The marker somebody did not fill
   *   in is removed and the block ends there. This is how a list is left
   *   without reaching for the mouse, and pressing Enter twice is the gesture
   *   everybody already knows.
   * - **Anywhere else, split.** What is before the caret stays and renders;
   *   what is after it becomes the next block, which is the one now being
   *   edited. At the end of a block — the common case — that is simply a new
   *   empty block below.
   *
   * Shift+Enter is left alone: a soft line break inside the block, which is why
   * this only claims the unmodified key.
   */
  function enter(event, i, field) {
    const caret = field.selectionStart;
    const upto = field.value.slice(0, caret);
    const lineFrom = upto.lastIndexOf("\n") + 1;
    const line = field.value.slice(lineFrom, caret);

    // A fence is verbatim; Enter inside one is a newline like any other.
    const fences = (field.value.slice(0, caret).match(/^\s*```/gm) || []).length;
    if (fences % 2 === 1) return;

    const marker = /^(\s*)([-*]\s+\[[ xX]\]\s+|[-*]\s+|\d+\.\s+)(.*)$/.exec(line);
    if (marker) {
      const [, indent, bullet, said] = marker;
      event.preventDefault();
      if (!said.trim()) {
        // An empty item: take the marker back off and leave the list. The
        // newline on each side of the line being removed goes with it —
        // otherwise the list keeps a trailing blank and whatever followed it
        // starts one line further down every time somebody leaves a list.
        const before = field.value.slice(0, lineFrom).replace(/\n$/, "");
        const after = field.value.slice(caret).replace(/^\n/, "");
        return breakAt(i, before, after, 0);
      }
      // Numbered lists count; bulleted ones repeat. A task continues unticked —
      // the box is for the new thing, not a copy of the old one's state.
      const numbered = /^(\d+)\.\s+$/.exec(bullet);
      const next = numbered
        ? `${Number(numbered[1]) + 1}. `
        : bullet.replace(/\[[xX]\]/, "[ ]");
      const inserted = `\n${indent}${next}`;
      field.value = field.value.slice(0, caret) + inserted + field.value.slice(caret);
      const to = caret + inserted.length;
      field.setSelectionRange(to, to);
      blocks[i] = { ...blocks[i], src: field.value };
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    event.preventDefault();
    breakAt(i, field.value.slice(0, caret), field.value.slice(caret), 0);
  }

  /** Split block `i` in two, and edit the second. */
  function breakAt(i, before, after, caret) {
    const held = blocks[i];
    blocks[i] = { src: before, sep: "\n\n" };
    blocks.splice(i + 1, 0, { src: after, sep: held.sep });
    // The block that ends the document keeps whatever ended it — a trailing
    // newline stays a trailing newline rather than becoming a paragraph break.
    editing = i + 1;
    landing = caret;
    changed();
    draw();
  }

  function source(i) {
    const box = el("div", "note-source");
    const field = document.createElement("textarea");
    field.value = blocks[i].src;
    field.spellcheck = false;
    box.appendChild(field);

    active = field;
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
      if (e.key === "Enter" && !e.shiftKey) return enter(e, i, field);
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
        /*
         * **And a blur because the editor moved is not a blur either.**
         *
         * Enter, and the arrow keys at a block's edge, open a different block —
         * which redraws, which removes this textarea, which blurs it. This
         * handler then ran and set `editing` to null, closing the block that had
         * just been opened: Enter rendered the document and left the caret
         * nowhere.
         *
         * Compared by identity, not by index. The first version asked whether
         * `editing` still pointed at this block's number, and two different
         * textareas can wear the same number — a block reopened at the index the
         * last one had. The stale blur then passed its own guard and closed the
         * editor a few milliseconds after it opened, which is a very confusing
         * thing to watch.
         */
        if (active !== field) return;
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
        active = null;
        draw();
      }, 0);
    });

    queueMicrotask(() => {
      field.focus();
      grow();
      const caret = landing === null ? field.value.length : landing;
      landing = null;
      field.setSelectionRange(caret, caret);
    });
    return box;
  }

  draw();
  return {
    get text() { return joined(blocks); },
    /** Replace the contents — for a note that changed under us. */
    set(next) { blocks = split(next); editing = null; draw(); },
  };
}
