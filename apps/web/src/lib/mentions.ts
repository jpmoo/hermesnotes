import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";

export type MentionChar = "@" | "#" | "|";

/** An item chosen from a mention dropdown — inserted as a markdown link. */
export interface MentionItem {
  label: string; // display text of the link
  href: string; // block:<id> or tag:<name>
}

export interface MentionState {
  char: MentionChar;
  query: string;
  rect: () => DOMRect | null;
  select: (item: MentionItem) => void;
}

export interface MentionHandlers {
  onOpen: (s: MentionState) => void;
  onUpdate: (s: MentionState) => void;
  onClose: () => void;
  /** ref holding the dropdown's keydown handler (returns true if it consumed the key) */
  keydown: { current: ((e: KeyboardEvent) => boolean) | null };
}

/**
 * Inline mentions for the markdown editors: `@` (people), `#` (tags), `|` (any
 * other type). Each trigger opens a React-rendered dropdown (driven via
 * `handlers`); picking an item inserts a markdown link so it round-trips.
 */
export const Mentions = Extension.create<{ handlers: MentionHandlers | null }>({
  name: "mentions",
  addOptions() {
    return { handlers: null };
  },
  addProseMirrorPlugins() {
    const handlers = this.options.handlers;
    if (!handlers) return [];
    const chars: MentionChar[] = ["@", "#", "|"];
    return chars.map((char) =>
      Suggestion<MentionItem>({
        editor: this.editor,
        char,
        pluginKey: new PluginKey(`mention-${char}`),
        allowSpaces: false,
        startOfLine: false,
        // Allow inside our raw source line (also a code node), but not inside a
        // real code block, where the chars are literal.
        allow: ({ state, range }) => {
          const parent = state.doc.resolve(range.from).parent;
          return parent.type.name === "sourceBlock" || !parent.type.spec.code;
        },
        // Items are fetched by the React dropdown; the built-in list is unused.
        items: () => [],
        command: ({ editor, range, props }) => {
          const inSource =
            editor.state.doc.resolve(range.from).parent.type.name === "sourceBlock";
          // In the raw source line insert the markdown link text (it re-chips
          // into a mention when the line renders); elsewhere insert the chip.
          const content = inSource
            ? [{ type: "text", text: `[${props.label}](${props.href}) ` }]
            : [
                { type: "mention", attrs: { href: props.href, label: props.label } },
                { type: "text", text: " " },
              ];
          editor.chain().focus().deleteRange(range).insertContent(content).run();
        },
        render: () => {
          const toState = (props: {
            query: string;
            clientRect?: (() => DOMRect | null) | null;
            command: (item: MentionItem) => void;
          }): MentionState => ({
            char,
            query: props.query,
            rect: () => props.clientRect?.() ?? null,
            select: (item) => props.command(item),
          });
          return {
            onStart: (props) => handlers.onOpen(toState(props)),
            onUpdate: (props) => handlers.onUpdate(toState(props)),
            onKeyDown: (props) => handlers.keydown.current?.(props.event) ?? false,
            onExit: () => handlers.onClose(),
          };
        },
      }),
    );
  },
});
