import type { Editor } from "@tiptap/core";

/**
 * markdown-it-task-lists only recognizes `- [ ] ` when there's text after the
 * checkbox, so an EMPTY checkbox parses to a plain bullet with literal "[ ]"
 * text — which then re-serializes as `- \[ \]`. Rewrite those bullets back into
 * empty task items in the parsed HTML.
 */
export function fixEmptyCheckboxesHtml(html: string): string {
  if (typeof html !== "string" || !html.includes("[")) return html;
  const div = document.createElement("div");
  div.innerHTML = html;
  let changed = false;
  div.querySelectorAll("li").forEach((li) => {
    if (li.getAttribute("data-type") === "taskItem") return;
    const m = /^\[([ xX])\]$/.exec((li.textContent ?? "").trim());
    if (!m) return;
    li.setAttribute("data-type", "taskItem");
    li.setAttribute("data-checked", /[xX]/.test(m[1]!) ? "true" : "false");
    li.innerHTML = "<p></p>";
    const ul = li.parentElement;
    if (ul && ul.tagName === "UL" && ul.getAttribute("data-type") !== "taskList") {
      ul.setAttribute("data-type", "taskList");
    }
    changed = true;
  });
  return changed ? div.innerHTML : html;
}

type PatchableParser = {
  parse: (content: unknown, opts?: unknown) => unknown;
  _emptyCbPatched?: boolean;
};

/**
 * Wrap the editor's markdown parser so every parse (initial content, raw→live
 * toggle, active-line render) repairs empty checkboxes. Idempotent.
 */
export function patchMarkdownParser(editor: Editor): void {
  const parser = (editor.storage.markdown as { parser?: PatchableParser } | undefined)?.parser;
  if (!parser || parser._emptyCbPatched) return;
  const orig = parser.parse.bind(parser);
  parser.parse = (content: unknown, opts?: unknown) => {
    const out = orig(content, opts);
    return typeof out === "string" ? fixEmptyCheckboxesHtml(out) : out;
  };
  parser._emptyCbPatched = true;
}
