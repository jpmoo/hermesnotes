/**
 * Templates — a named piece of prose you can drop into any long-text field.
 *
 * A template is not a new kind of thing: it's a text block wearing a marker,
 * the same trick the daily notes use. That means it edits with the ordinary
 * markdown surface and carries everything that surface carries — headings,
 * lists, checkboxes, and @/#/| mentions that keep working once it's been
 * applied somewhere.
 */

/** The `properties` key that marks a block as a template. Value: its name. */
export const TEMPLATE_MARKER = "template_name";

/** Preferences naming the template each kind of periodic note starts from. */
export const DAILY_TEMPLATE_PREF = "daily_template";
export const WEEKLY_TEMPLATE_PREF = "weekly_template";

/** A line that is nothing but a slash marks where the caret should land. */
const CARET_LINE = /^[ \t]*\/[ \t]*$/;

/**
 * A line that is nothing but `%` marks where text carried forward from the last
 * daily note or weekly reflection should be set down. Without one it arrives at
 * the very top, which is right when there's nothing else there and wrong the
 * moment a template puts a heading above it.
 *
 * Markdown claims almost every punctuation mark at the start of a line, and the
 * first choice, `>`, claimed the worst of them: a lone `>` parses as an empty
 * blockquote, which can serialize back to nothing at all. Every spelling this
 * has had is still honoured — a template written with one shouldn't stop
 * working — and a leading backslash is allowed, since a markdown serializer
 * that decides to escape the mark shouldn't stop it being the mark.
 */
const INHERIT_LINE = /^[ \t]*\\?(%%?|\^|>)[ \t]*$/;

/** The template's name, or null for an ordinary block. */
export function templateName(properties: unknown): string | null {
  const v = (properties as Record<string, unknown> | null | undefined)?.[TEMPLATE_MARKER];
  return typeof v === "string" ? v : null;
}

/**
 * Where the caret goes when a field carrying this text is activated: the
 * offset, in characters, of the line marked with a lone `/`. Null when the
 * text doesn't ask for one — most templates don't, and then the caret behaves
 * as it always has.
 *
 * A whole line rather than an inline token so the mark can't be mistaken for
 * a date, a fraction or a path, and so removing it doesn't leave a gap in a
 * sentence.
 */
export function caretOffset(text: string | null | undefined): number | null {
  if (!text) return null;
  const lines = text.split("\n");
  let at = 0;
  for (const line of lines) {
    if (CARET_LINE.test(line)) return at;
    at += line.length + 1;
  }
  return null;
}

/** Whether this line is the caret mark. */
export function isCaretLine(line: string): boolean {
  return CARET_LINE.test(line);
}

/** Whether this line is the mark for text carried in from the last note. */
export function isInheritLine(line: string): boolean {
  return INHERIT_LINE.test(line);
}

/**
 * Set `carried` down where the text asks for it: in place of the `>` line if
 * there is one, at the top if there isn't. Returns the whole body.
 */
export function placeCarried(body: string, carried: string): string {
  const text = carried.replace(/\n+$/, "");
  if (!body) return text ? `${text}\n\n` : "";
  const lines = body.split("\n");
  const at = lines.findIndex(isInheritLine);
  if (at < 0) return text ? `${text}\n\n${body}` : body;
  // The mark is consumed: it says where, not what, and leaving it behind would
  // collect a second copy every day. Somebody who asked for the space said it
  // matters to them, so when nothing came through the space says so rather than
  // closing up as if the question had never been asked.
  lines.splice(at, 1, ...(text ? text.split("\n") : [EMPTY_CARRY]));
  return lines.join("\n");
}

/** Stands in for the carried text when there wasn't any. */
export const EMPTY_CARRY = "*(nothing to carry forward from previous notes)*";
