import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * Text that keeps coming back — a mark, not a node.
 *
 * The first version wrapped the run in a mention node whose whole payload was
 * one string, which meant a sentence naming `|Acme` arrived in tomorrow's note
 * as the bare word "Acme": the words travelled and the connection didn't. A
 * mark wraps ordinary inline content instead, mentions and all, so what comes
 * through is what was written — chips that link, appear in the graph, and are
 * picked up by a rollup keyed on them.
 *
 * Stored as `<mark data-fwd="<iso>">…</mark>`. Inline HTML because markdown has
 * no syntax for "these words, with a date attached", and because markdown-it
 * parses the text *between* inline tags normally — so the mentions inside stay
 * mentions rather than becoming a flattened label.
 */
export const ForwardMark = Mark.create({
  name: "forwarded",
  // The dates inside two adjacent runs differ, and merging them would give the
  // pair one date and lose the other's place in the order.
  inclusive: false,

  addAttributes() {
    return {
      since: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-fwd") ?? "",
        renderHTML: (attrs) => ({ "data-fwd": String(attrs.since ?? "") }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "mark[data-fwd]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes, { class: "fwd-mark" }), 0];
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open: (_state: unknown, mark: { attrs: { since?: string } }) =>
            `<mark data-fwd="${String(mark.attrs.since ?? "").replace(/"/g, "&quot;")}">`,
          close: "</mark>",
          // The content between the tags is ordinary markdown, so a mention
          // inside serializes as a mention.
          mixable: true,
          expelEnclosingWhitespace: true,
        },
        parse: {},
      },
    };
  },
});
