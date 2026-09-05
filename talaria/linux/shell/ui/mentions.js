/*
 * `@`, `#` and `|` — the three pickers, on a plain textarea.
 *
 * Hermes' own are a ProseMirror suggestion plugin (`apps/web/src/lib/
 * mentions.ts`) and the vocabulary is taken from there rather than invented:
 * `@` is people, `#` is tags, `|` is anything else, and **each one inserts an
 * ordinary markdown link** — `[Title](block:<id>)`, `[name](tag:<name>)` — so
 * what lands in the note round-trips through anything that reads markdown. The
 * chip is a rendering, not a format.
 *
 * `@` reads the block's *kind* and never its type's name. Kind comes from the
 * profile a type declares, so a library whose person type is called "Contact"
 * still finds its people — which is the repo's first invariant, and the reason
 * this asks the daemon rather than matching a string.
 */
import { get } from "/ui/api.js";

/** Everything nameable, fetched once and shared by every field on the page. */
let catalog = null;
let tags = null;

async function load() {
  if (catalog) return;
  const spotlight = await get("/spotlight");
  catalog = (spotlight.items || []).map((b) => ({
    id: b.id, title: b.title || "(untitled)", kind: b.kind,
    typeName: b.typeName, url: b.url, tags: b.tags || [],
  }));
  // The tag list is not an endpoint; it is what the blocks are wearing. That
  // also makes it exactly right — a tag nothing carries is not one to offer.
  const seen = new Map();
  for (const block of catalog) {
    for (const tag of block.tags) seen.set(tag, (seen.get(tag) || 0) + 1);
  }
  tags = [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

const TRIGGERS = {
  "@": { what: "people", find: (q) => blocks(q, (b) => b.kind === "person") },
  "|": { what: "anything", find: (q) => blocks(q, () => true) },
  "#": { what: "tags", find: (q) => matchTags(q) },
};

function blocks(query, keep) {
  const q = query.toLowerCase();
  return catalog
    .filter(keep)
    .filter((b) => !q || b.title.toLowerCase().includes(q))
    // A prefix match is what somebody typing three letters meant; a match in
    // the middle is a match all the same, and goes below it.
    .sort((a, b) => rank(a.title, q) - rank(b.title, q) || a.title.localeCompare(b.title))
    .slice(0, 8)
    .map((b) => ({ label: b.title, href: `block:${b.id}`, note: b.typeName }));
}

function matchTags(query) {
  const q = query.toLowerCase();
  return tags
    .filter((t) => !q || t.name.toLowerCase().includes(q))
    .sort((a, b) => rank(a.name, q) - rank(b.name, q) || b.count - a.count)
    .slice(0, 8)
    .map((t) => ({ label: t.name, href: `tag:${t.name}`, note: `${t.count}` }));
}

const rank = (text, q) => (!q ? 0 : text.toLowerCase().startsWith(q) ? 0 : 1);

/**
 * The word being typed, if it started with a trigger.
 *
 * Bounded at a space on purpose — `allowSpaces: false` in Hermes' plugin — and
 * at the start of a word, so an email address does not open the people picker
 * halfway through.
 */
function trigger(field) {
  const upto = field.value.slice(0, field.selectionStart);
  const match = /(^|[\s(([\n])([@#|])([^\s@#|]*)$/.exec(upto);
  if (!match) return null;
  return { char: match[2], query: match[3], from: upto.length - match[3].length - 1 };
}

/**
 * Attach the pickers to one textarea.
 *
 * Returns a `keydown` that says whether it swallowed the key, because the field
 * this decorates has its own opinions about Enter and Escape and the dropdown
 * must be asked first.
 */
export function mentions(field, host) {
  const menu = document.createElement("div");
  menu.className = "mention-menu";
  menu.hidden = true;
  host.appendChild(menu);

  let open = null;
  let items = [];
  let at = 0;

  function close() {
    open = null;
    items = [];
    menu.hidden = true;
    menu.replaceChildren();
  }

  function draw() {
    menu.replaceChildren();
    for (const [i, item] of items.entries()) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mention-row" + (i === at ? " here" : "");
      const label = document.createElement("span");
      label.textContent = (open.char === "#" ? "#" : "") + item.label;
      row.appendChild(label);
      if (item.note) {
        const note = document.createElement("span");
        note.className = "mention-note";
        note.textContent = item.note;
        row.appendChild(note);
      }
      // `mousedown` rather than `click`: a click on the menu blurs the field
      // first, and the field's blur handler puts the line back to rendered
      // markdown — so by the time a click arrived there was nothing to insert
      // into.
      row.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
      menu.appendChild(row);
    }
    menu.hidden = !items.length;
    place();
  }

  /* Under the caret's line, which is close enough on a field this size and
   * needs no hidden mirror element to measure. */
  function place() {
    const box = field.getBoundingClientRect();
    const frame = host.getBoundingClientRect();
    const lines = field.value.slice(0, field.selectionStart).split("\n").length;
    const lineHeight = parseFloat(getComputedStyle(field).lineHeight) || 18;
    const y = box.top - frame.top + Math.min(lines * lineHeight, box.height) + 4;
    menu.style.top = `${y}px`;
    menu.style.left = `${box.left - frame.left + 8}px`;
  }

  function choose(i) {
    const item = items[i];
    if (!item || !open) return;
    const before = field.value.slice(0, open.from);
    const after = field.value.slice(field.selectionStart);
    const inserted = `[${item.label}](${item.href})`;
    field.value = before + inserted + after;
    const caret = before.length + inserted.length;
    field.setSelectionRange(caret, caret);
    close();
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus();
  }

  async function refresh() {
    const found = trigger(field);
    if (!found) return close();
    try {
      await load();
    } catch {
      // No catalog, no picker. The character stays where it was typed, which is
      // the right outcome: `|` is also just a character.
      return close();
    }
    open = found;
    items = TRIGGERS[found.char].find(found.query);
    at = 0;
    draw();
  }

  field.addEventListener("input", refresh);
  field.addEventListener("blur", () => setTimeout(close, 0));

  return {
    get open() { return !menu.hidden; },
    keydown(e) {
      if (menu.hidden) return false;
      if (e.key === "ArrowDown") { at = (at + 1) % items.length; draw(); return true; }
      if (e.key === "ArrowUp") { at = (at - 1 + items.length) % items.length; draw(); return true; }
      if (e.key === "Enter" || e.key === "Tab") { choose(at); return true; }
      if (e.key === "Escape") { close(); return true; }
      return false;
    },
    close,
  };
}
