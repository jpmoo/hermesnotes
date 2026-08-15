import { Mark, mergeAttributes } from "@tiptap/core";
import { forwardOpenTag } from "@hermes/shared";

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
        renderHTML: (attrs) => (attrs.since ? { "data-fwd": String(attrs.since) } : {}),
      },
      // Where it set out from, on a copy that has travelled. Carried through
      // the editor so a day you open and save doesn't quietly strip the origin
      // off everything it was handed.
      from: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-from") ?? "",
        renderHTML: (attrs) =>
          attrs.from ? { "data-from": String(attrs.from) } : {},
      },
    };
  },

  // Both: a mark with only an origin is text sent to this day in particular. It
  // isn't travelling, but it is the same kind of thing, and if the editor didn't
  // know it the first save of that day would drop the tag and with it the answer
  // to "where did this come from".
  parseHTML() {
    return [{ tag: "mark[data-fwd]" }, { tag: "mark[data-from]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes, { class: "fwd-mark" }), 0];
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open: (_state: unknown, mark: { attrs: { since?: string; from?: string } }) =>
            forwardOpenTag(
              String(mark.attrs.since ?? "") || undefined,
              String(mark.attrs.from ?? "") || undefined,
            ),
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
