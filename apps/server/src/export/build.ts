import type { PropertySchema, FieldDef } from "@hermes/shared";

/**
 * Turns Hermes blocks into Obsidian-compatible markdown. Body is the block's
 * long-text (text blocks use their content); every other property becomes YAML
 * frontmatter keyed by the field's human label; connections (references +
 * embedded mentions) become `[[wikilinks]]`; attachments embed from ./attachments.
 */

const UUID = "[0-9a-fA-F-]{36}";

/** A field's display label — its configured label, or a title-cased key. */
export function labelOf(f: FieldDef): string {
  if (f.label && f.label.trim()) return f.label.trim();
  return f.key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export interface ParsedMentions {
  /** Human-readable text: link/person labels kept, tags and bare ids removed. */
  plain: string;
  /** Referenced block ids (from `[label](block:id)` and bare `|id`). */
  blockIds: string[];
  /** Person names (from `@Name` and `[label](person:Name)`). */
  personNames: string[];
  /** Tag names (from `#tag` and `[..](tag:name)`), lower-cased. */
  tags: string[];
}

/**
 * Parse a raw text/title field's mention syntax. The returned `plain` keeps the
 * readable labels (so a title stays legible) but drops tags and bare ids; the
 * extracted connections/tags are handed back so the caller can preserve them as
 * wikilinks / YAML tags elsewhere in the note (never silently lost).
 */
export function parseMentions(raw: string): ParsedMentions {
  const blockIds: string[] = [];
  const personNames: string[] = [];
  const tags: string[] = [];
  let plain = String(raw ?? "");

  plain = plain.replace(/\[([^\]]*)\]\((block|person|tag):([^)]*)\)/g, (_m, label: string, scheme: string, arg: string) => {
    if (scheme === "block") {
      blockIds.push(arg);
      return label;
    }
    if (scheme === "person") {
      personNames.push((label || arg).replace(/_/g, " "));
      return label;
    }
    tags.push(arg.trim().toLowerCase());
    return ""; // a tag isn't a readable label — drop from the title text
  });
  plain = plain.replace(new RegExp(`\\|(${UUID})`, "g"), (_m, id: string) => {
    blockIds.push(id);
    return "";
  });
  plain = plain.replace(/(^|\s)@([A-Za-z0-9][\w-]*)/g, (_m, s: string, n: string) => {
    personNames.push(n.replace(/_/g, " "));
    return `${s}${n.replace(/_/g, " ")}`;
  });
  plain = plain.replace(/(^|\s)#([A-Za-z0-9][\w-]*)/g, (_m, s: string, n: string) => {
    tags.push(n.toLowerCase());
    return s;
  });
  plain = plain.replace(/\s+/g, " ").trim();
  return { plain, blockIds, personNames, tags };
}

/** Just the readable title text (labels kept, tags/ids removed). */
export function plainTitle(raw: string): string {
  return parseMentions(raw).plain;
}

/** Filesystem/Obsidian-safe file name (no extension). */
export function safeName(name: string): string {
  const cleaned = (name || "Untitled")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ") // illegal on some FS + Obsidian link-breaking chars
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "") // no leading dots (hidden files)
    .trim();
  return (cleaned || "Untitled").slice(0, 120);
}

function yamlKey(k: string): string {
  return /[:#{}[\],&*!|>'"%@`]/.test(k) ? JSON.stringify(k) : k;
}

function yamlScalar(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  // Everything else is quoted so colons, hashes, etc. can't break the YAML.
  return JSON.stringify(String(v));
}

export interface FrontmatterPair {
  key: string;
  value: unknown;
}

/** Build a YAML frontmatter block from label/value pairs + tags. */
export function frontmatter(pairs: FrontmatterPair[], tags: string[]): string {
  const lines: string[] = ["---"];
  for (const { key, value } of pairs) {
    if (value === null || value === undefined || value === "") continue;
    lines.push(`${yamlKey(key)}: ${yamlScalar(value)}`);
  }
  if (tags.length) {
    lines.push("tags:");
    for (const t of tags) lines.push(`  - ${t}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

export interface BodyResolvers {
  /**
   * The exported note's base name (no extension) that a linked block id should
   * point at — or `undefined` to drop the link (a collection, an empty daily
   * note, a weekly review with no reflection, etc.). Redirection (weekly review
   * → its reflection, daily note → its scratchpad) is resolved by the caller.
   */
  titleOf: (id: string) => string | undefined;
  /** Exported file name for an attachment id, if it's part of this export. */
  attachmentName: (id: string) => string | undefined;
}

/**
 * Rewrite a long-text body into Obsidian markdown: embedded block mentions and
 * links become `[[wikilinks]]`, tag links become `#tags`, and inline attachment
 * images embed by name. Returns the new body plus the set of attachment ids that
 * ended up embedded inline (so the caller can append the rest).
 */
export function bodyToObsidian(
  md: string,
  r: BodyResolvers,
): { body: string; inlinedAttachments: Set<string> } {
  const inlined = new Set<string>();
  let out = md ?? "";

  // Inline attachment images: ![alt](attachment:<id>) -> ![[filename]]
  out = out.replace(new RegExp(`!\\[[^\\]]*\\]\\(attachment:(${UUID})\\)`, "g"), (m, id: string) => {
    const name = r.attachmentName(id);
    if (!name) return m;
    inlined.add(id);
    return `![[${name}]]`;
  });

  // Block links: [label](block:<id>) -> [[Target|label]]. A dropped target
  // (collection/empty) keeps the readable label as plain text.
  out = out.replace(new RegExp(`\\[([^\\]]*)\\]\\(block:(${UUID})\\)`, "g"), (_m, label: string, id: string) => {
    const target = r.titleOf(id);
    if (!target) return label ?? "";
    return label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`;
  });

  // Tag links: [#name](tag:name) or [name](tag:name) -> #name
  out = out.replace(/\[([^\]]*)\]\(tag:([^)]+)\)/g, (_m, _label: string, name: string) => `#${name.trim()}`);

  // Bare block mentions that survive in raw text fields.
  out = out.replace(new RegExp(`\\|(${UUID})`, "g"), (_m, id: string) => {
    const target = r.titleOf(id);
    return target ? `[[${target}]]` : "";
  });

  return { body: out, inlinedAttachments: inlined };
}

export interface ExportBlockInput {
  id: string;
  content: string | null;
  properties: Record<string, unknown>;
  isText: boolean;
  schema: PropertySchema | null;
  title: string;
  tags: string[];
  /** All attachment rows for this block, with their exported file names. */
  attachments: { id: string; name: string }[];
  /** Force a `title:` into the frontmatter (text notes have no title field). */
  titleInFrontmatter?: boolean;
}

/** Render one block to a complete Obsidian markdown document. */
export function blockToMarkdown(b: ExportBlockInput, r: BodyResolvers): string {
  const pairs: FrontmatterPair[] = [];
  if (b.titleInFrontmatter && b.title) pairs.push({ key: "title", value: b.title });

  const refBlockIds: string[] = []; // connections to append as wikilinks
  const personNames: string[] = [];
  const extraTags: string[] = [];
  const longTexts: string[] = [];

  // Mentions embedded in a title/text field: keep the readable label in the
  // value, but preserve the connection (wikilink) and tags (YAML) elsewhere.
  const harvest = (raw: string): string => {
    const p = parseMentions(raw);
    refBlockIds.push(...p.blockIds);
    personNames.push(...p.personNames);
    extraTags.push(...p.tags);
    return p.plain;
  };

  if (!b.isText && b.schema) {
    // The title field's own mentions still count as connections/tags.
    const rawTitle = b.properties.title;
    if (typeof rawTitle === "string") harvest(rawTitle);

    for (const f of [...b.schema.fields].sort((a, c) => a.order - c.order)) {
      const v = b.properties[f.key];
      if (f.key === "title") continue; // carried by the file name (+ optional fm above)
      if (f.type === "longtext") {
        if (typeof v === "string" && v.trim()) longTexts.push(v);
        continue;
      }
      if (f.type === "attachments" || f.type === "recurrence") continue; // handled / skipped
      if (f.type === "reference") {
        const ids = Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : [];
        refBlockIds.push(...ids);
        continue;
      }
      if (f.type === "datespan") {
        const span = (v ?? {}) as { start?: string; end?: string };
        if (span.start) pairs.push({ key: f.startLabel?.trim() || `${labelOf(f)} start`, value: span.start });
        if (span.end) pairs.push({ key: f.endLabel?.trim() || `${labelOf(f)} end`, value: span.end });
        continue;
      }
      if (v === null || v === undefined || v === "") continue;
      // Plain text fields may carry mentions too — preserve them like the title.
      pairs.push({ key: labelOf(f), value: f.type === "text" ? harvest(String(v)) : v });
    }
  }

  // Body: text blocks use content; typed blocks use their long-text field(s).
  const rawBody = b.isText ? b.content ?? "" : longTexts.join("\n\n");
  const { body, inlinedAttachments } = bodyToObsidian(rawBody, r);

  const tags = [...new Set([...b.tags, ...extraTags])];

  // Trailing sections: reference/mention connections, then any loose files.
  const trailing: string[] = [];
  const seen = new Set<string>();
  const wiki: string[] = [];
  for (const id of refBlockIds) {
    const target = r.titleOf(id); // undefined = collection / empty / gone → skip
    if (target && !seen.has(`b:${target}`)) {
      seen.add(`b:${target}`);
      wiki.push(`- [[${target}]]`);
    }
  }
  for (const name of personNames) {
    if (name && !seen.has(`p:${name}`)) {
      seen.add(`p:${name}`);
      wiki.push(`- [[${name}]]`);
    }
  }
  if (wiki.length) trailing.push(`## Connections\n${wiki.join("\n")}`);

  const loose = b.attachments.filter((a) => !inlinedAttachments.has(a.id));
  if (loose.length) {
    trailing.push(`## Attachments\n${loose.map((a) => `- ![[${a.name}]]`).join("\n")}`);
  }

  const parts = [frontmatter(pairs, tags), body.trim()];
  if (trailing.length) parts.push("", trailing.join("\n\n"));
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
