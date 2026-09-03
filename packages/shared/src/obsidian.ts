/**
 * Reading an Obsidian vault.
 *
 * The inverse of `apps/server/src/export/build.ts`, and deliberately so: that
 * file writes wikilinks, YAML tags and `./attachments` embeds out of Hermes,
 * this one reads them back in. Where the two disagree a round trip loses
 * something, which makes export→import the cheapest real test this has.
 *
 * Pure on purpose — paths and text in, a plan out, no fetch and no database.
 * The browser runs it to show somebody what an import will do before it does
 * it; the server runs nothing else. Keeping it here means the preview and the
 * import cannot drift into two different readings of the same vault.
 */

/** Vault-relative POSIX path, e.g. `Nuclear/A Boat.md`. */
export type VaultPath = string;

/**
 * Every path in the vault, indexed the two ways Obsidian resolves a link.
 *
 * Obsidian matches `[[folder/Note]]` against the path and `[[Note]]` against
 * the basename anywhere in the vault, with or without the extension, which is
 * why each file goes in four times. The bare-basename route is not a nicety to
 * skip: a real vault writes `![[A Boat 2023-02-18 08.50.40.excalidraw]]` for a
 * file three folders away, and resolving only full paths would drop it.
 */
export interface VaultIndex {
  byPath: Map<string, VaultPath>;
  byBase: Map<string, VaultPath[]>;
}

const stripExt = (p: string) => p.replace(/\.[^./]+$/, "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function buildIndex(paths: readonly VaultPath[]): VaultIndex {
  const byPath = new Map<string, VaultPath>();
  const byBase = new Map<string, VaultPath[]>();
  for (const p of paths) {
    byPath.set(p, p);
    byPath.set(stripExt(p), p);
    for (const k of [baseOf(p), stripExt(baseOf(p))]) {
      const list = byBase.get(k) ?? [];
      list.push(p);
      byBase.set(k, list);
    }
  }
  // Shortest path wins a tie, which is Obsidian's own rule and the reason a
  // note at the vault root beats one buried six folders down. Ties beyond that
  // are reported rather than guessed at — see `ambiguous`.
  for (const list of byBase.values()) {
    list.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  }
  return { byPath, byBase };
}

/** Where a link target points, or null when it points nowhere. */
export function resolveTarget(target: string, index: VaultIndex): VaultPath | null {
  const t = target.trim().replace(/^\.\//, "");
  if (!t) return null;
  return index.byPath.get(t) ?? index.byBase.get(t)?.[0] ?? null;
}

/** True when a bare target matched more than one file and the tie was broken. */
export function isAmbiguous(target: string, index: VaultIndex): boolean {
  const t = target.trim().replace(/^\.\//, "");
  if (index.byPath.has(t)) return false;
  return (index.byBase.get(t)?.length ?? 0) > 1;
}

/**
 * A tag name Hermes will accept.
 *
 * Hermes matches `#[A-Za-z0-9][\w-]*`, which has no room for the slash in
 * Obsidian's `#projects/home` — so nesting flattens to a hyphen rather than
 * being truncated at the slash, which would silently merge `#a/x` and `#a/y`
 * into one tag. Everything else illegal goes the same way, and a leading
 * non-alphanumeric is dropped because the pattern will not start on one.
 */
export function flattenTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "")
    .toLowerCase();
}

/**
 * Blank out fenced blocks and inline code, keeping length and line breaks.
 *
 * Extraction runs over the masked copy and rewriting over the real one, so a
 * `#hashtag` or `[[link]]` written inside a code sample stays a code sample.
 * Length has to be preserved because the offsets found in the mask are used to
 * cut the original.
 */
function maskCode(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/^```[\s\S]*?^```/gm, blank)
    .replace(/^~~~[\s\S]*?^~~~/gm, blank)
    .replace(/`[^`\n]*`/g, blank);
}

/** The YAML front matter as written, and the rest. Neither is reformatted. */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!m || m.index !== 0) return { frontmatter: "", body: text };
  return { frontmatter: m[0], body: text.slice(m[0].length) };
}

export interface NoteLink {
  /** The `[[...]]` exactly as written, for replacement in the body. */
  raw: string;
  /** Character offset of `raw` in the note's body. */
  at: number;
  /** The target as written, alias and anchor removed. */
  target: string;
  /** What a reader should see: the alias, else the target's basename. */
  label: string;
  /** `![[...]]` — a file to bring across rather than a link to follow. */
  embed: boolean;
  /** Vault path it points at, or null when it points at nothing. */
  resolved: VaultPath | null;
  /** Matched a bare basename that more than one file answers to. */
  ambiguous: boolean;
}

/**
 * `[[target#anchor|alias]]`, with an optional leading `!`.
 *
 * The anchor is dropped rather than kept: it addresses a heading or a block
 * inside the target, and Hermes links to a block as a whole. Dropping it loses
 * precision; keeping it would produce a link that resolves to nothing.
 */
const WIKILINK = /(!?)\[\[([^\]|#^]+)((?:[#^][^\]|]*)?)(?:\|([^\]]*))?\]\]/g;

/** `#tag`, only where a tag can start: line beginning or after whitespace. */
const HASHTAG = /(^|\s)#([A-Za-z0-9][\w/-]*)/g;

/**
 * Obsidian syntax Hermes has no node for, counted so it can be said out loud.
 *
 * The editor is TipTap with the starter kit: paragraphs, headings, lists, task
 * lists, quotes, code, images, links. Anything outside that is not merely
 * styled differently — it is parsed to a node the schema does not have and
 * dropped on the way in. Silence about that is how somebody finds out a month
 * later that a table is gone.
 */
export interface Quirks {
  /** `^a1b2c3` — Obsidian's internal address for a paragraph. */
  blockAnchors: number;
  /** `> [!NOTE]` — rewritten to a bold-led quote, which is close. */
  callouts: number;
  /** `%%hidden%%` — invisible in Obsidian, so shown here would be a change. */
  comments: number;
  /** `==marked==` — no highlight mark; becomes bold. */
  highlights: number;
  /** A pipe table. There is no table node: this one cannot be saved. */
  tables: number;
}

/**
 * Make a note say the same thing in the markdown Hermes actually parses.
 *
 * Every rewrite here is a thing that would otherwise arrive as literal
 * punctuation in the middle of a sentence. Tables are the exception — they are
 * counted and left alone, because there is nothing to turn them into and
 * mangling them would only hide the loss.
 */
export function normalize(body: string): { text: string; quirks: Quirks } {
  const quirks: Quirks = { blockAnchors: 0, callouts: 0, comments: 0, highlights: 0, tables: 0 };
  let text = body;

  // `> [!NOTE] Title` → `> **Note** — Title`. A callout is a quote with a kind,
  // and a quote with its kind in bold is the same sentence.
  // `[ \t]`, never `\s`: `\s` matches a newline, and the first version of this
  // ate the line after every callout that had nothing on its own line.
  text = text.replace(/^([ \t]*>[ \t]*)\[!([A-Za-z]+)\]-?[ \t]*(.*)$/gm, (_m, q: string, kind: string, rest: string) => {
    quirks.callouts++;
    const name = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
    return `${q}**${name}**${rest.trim() ? ` — ${rest.trim()}` : ""}`;
  });

  // `%%…%%` is invisible in Obsidian. Rendering it would be showing somebody
  // something they wrote in order not to see.
  text = text.replace(/%%[\s\S]*?%%/g, () => { quirks.comments++; return ""; });

  text = text.replace(/==([^=\n]+)==/g, (_m, inner: string) => { quirks.highlights++; return `**${inner}**`; });

  // A block anchor addresses a paragraph from elsewhere in the vault. The links
  // that used it already had their anchors dropped, so it now names nothing.
  text = text.replace(/^(.*?)[ \t]*\^[A-Za-z0-9-]{4,}[ \t]*$/gm, (m, before: string) => {
    if (!/\S/.test(before)) return m;
    quirks.blockAnchors++;
    return before.replace(/[ \t]+$/, "");
  });

  quirks.tables = (text.match(/^\|[^\n]*\|[ \t]*$\n^\|[ \t:-]+\|[ \t]*$/gm) ?? []).length;
  return { text, quirks };
}

export interface ParsedNote {
  path: VaultPath;
  /** The file name without `.md` — which becomes the note's first line. */
  title: string;
  frontmatter: string;
  body: string;
  /** Flattened, lower-cased, first appearance first. */
  tags: string[];
  links: NoteLink[];
  /** A few words of real prose, for showing somebody what they are importing. */
  excerpt: string;
  quirks: Quirks;
}

export function parseNote(path: VaultPath, text: string, index: VaultIndex): ParsedNote {
  const split = splitFrontmatter(text.replace(/\r\n/g, "\n"));
  const { frontmatter } = split;
  // Before anything measures an offset, because normalizing moves them.
  const { text: body, quirks } = normalize(split.body);
  const masked = maskCode(body);

  const links: NoteLink[] = [];
  for (const m of masked.matchAll(WIKILINK)) {
    const target = (m[2] ?? "").trim();
    const alias = m[4]?.trim();
    links.push({
      raw: body.slice(m.index, m.index + m[0].length),
      at: m.index,
      target,
      label: alias || stripExt(baseOf(target)),
      embed: m[1] === "!",
      resolved: resolveTarget(target, index),
      ambiguous: isAmbiguous(target, index),
    });
  }

  const tags: string[] = [];
  const seen = new Set<string>();
  // Front matter carries tags too, and they are the same tags — a vault that
  // writes `tags: [a, b]` there means what a `#a` in the body means.
  const fmTags = /^tags:[ \t]*(.*)$/m.exec(frontmatter);
  if (fmTags) {
    const inline = fmTags[1] ?? "";
    const listed = /^\[(.*)\]$/.exec(inline.trim());
    const after = frontmatter.slice((fmTags.index ?? 0) + fmTags[0].length);
    const block = [...after.matchAll(/^[ \t]*-[ \t]*(.+)$/gm)].map((x) => x[1] ?? "");
    for (const raw of [...(listed ? (listed[1] ?? "").split(",") : [inline]), ...block]) {
      const n = flattenTag(raw.replace(/["']/g, ""));
      if (n && !seen.has(n)) { seen.add(n); tags.push(n); }
    }
  }
  for (const m of masked.matchAll(HASHTAG)) {
    const n = flattenTag(m[2] ?? "");
    if (n && !seen.has(n)) { seen.add(n); tags.push(n); }
  }

  // The excerpt is prose, so it skips the furniture: headings, the tag lists a
  // vault tends to pile at the foot of a note, links reduced to their labels.
  const prose = masked
    .replace(WIKILINK, (_m, _b, t: string, _a: string, alias?: string) => alias || stripExt(baseOf(t)))
    .replace(HASHTAG, "")
    .replace(/^#{1,6}[ \t]+.*$/gm, "")
    .replace(/^[-*+>]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    path,
    title: stripExt(baseOf(path)),
    frontmatter,
    body,
    tags,
    links,
    excerpt: prose.length > 240 ? `${prose.slice(0, 240).trimEnd()}…` : prose,
    quirks,
  };
}

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * What one imported note will become.
 *
 * `key` is how notes refer to each other before any of them exist. The body
 * carries `[Label](import:<key>)` where a link goes, and the server swaps each
 * one for `block:<id>` once it has minted the ids — which it can do in a single
 * pass, because `POST /blocks` takes a caller-supplied id.
 */
export interface PlannedNote {
  key: string;
  kind: "note" | "stub" | "file";
  title: string;
  /** Ready to write, but for `import:` links. */
  body: string;
  tags: string[];
  /** Vault paths of files to attach to this note. */
  attach: VaultPath[];
  /** Preview only. */
  excerpt: string;
  linkCount: number;
  sourcePath?: VaultPath;
}

export interface ImportPlan {
  notes: PlannedNote[];
  /** Every file to upload, once each, and the note that holds it. */
  files: { path: VaultPath; host: string }[];
  /** Every tag the import will create or reuse. */
  tags: string[];
  /** Things worth reading before saying yes. */
  warnings: string[];
}

const STUB = (name: string) => `stub:${name.toLowerCase()}`;
const FILE = (path: VaultPath) => `file:${path}`;

/**
 * Turn parsed notes into the thing that will actually be written.
 *
 * Three decisions live here, all of them visible in the confirmation before
 * anything is written:
 *
 * - A link that resolves to nothing, or to a note outside the folder being
 *   imported, becomes a **stub**: an empty note with the right title, so the
 *   link survives and the note is one click from being written.
 * - A file referenced **once** is attached to the note that references it.
 * - A file referenced **more than once** gets a note of its own, holding the
 *   single copy, which every referencing note links to. Attachment bytes live
 *   inline in Postgres, so nineteen references to one canvas would otherwise be
 *   nineteen copies of it.
 */
export function planImport(
  notes: readonly ParsedNote[],
  opts: { inFolder: (p: VaultPath) => boolean },
): ImportPlan {
  const warnings: string[] = [];
  const inside = new Set(notes.map((n) => n.path));

  // How many notes reference each file — the number that decides attach-here
  // from note-of-its-own.
  const fileRefs = new Map<VaultPath, Set<VaultPath>>();
  for (const n of notes) {
    for (const l of n.links) {
      if (!l.resolved || l.resolved.endsWith(".md")) continue;
      const set = fileRefs.get(l.resolved) ?? new Set();
      set.add(n.path);
      fileRefs.set(l.resolved, set);
    }
  }
  const shared = new Set([...fileRefs].filter(([, s]) => s.size > 1).map(([p]) => p));

  const stubs = new Map<string, string>(); // key -> title
  const planned: PlannedNote[] = [];
  const files: { path: VaultPath; host: string }[] = [];
  const allTags = new Set<string>();
  let ambiguous = 0;

  for (const n of notes) {
    const attach: VaultPath[] = [];
    // Rewrite from the end, so an earlier replacement never moves a later
    // offset. Every link was recorded with the offset it was found at.
    let body = n.body;
    for (const l of [...n.links].sort((a, b) => b.at - a.at)) {
      if (l.ambiguous) ambiguous++;
      let replacement: string;
      if (l.resolved && !l.resolved.endsWith(".md")) {
        // A file stays where the author put it. `GET /attachments/:id` is keyed
        // by the attachment alone, so a body can point straight at one — an
        // image renders in place, a PDF is a link in the sentence that
        // introduced it. Only the bytes need an owner, and a file referenced
        // once is owned by the note referencing it.
        //
        // The id does not exist yet, so this leaves a marker. The client swaps
        // it for a URL after uploading, because the API base is a thing only
        // the browser knows — Caddy strips a prefix this server never sees.
        if (!shared.has(l.resolved)) attach.push(l.resolved);
        const img = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(l.resolved);
        replacement = `${l.embed && img ? "!" : ""}[${l.label}](attach:${l.resolved})`;
      } else if (l.resolved && inside.has(l.resolved) && opts.inFolder(l.resolved)) {
        replacement = `[${l.label}](import:${l.resolved})`;
      } else {
        const title = l.resolved ? stripExt(baseOf(l.resolved)) : l.target.trim();
        stubs.set(STUB(title), title);
        replacement = `[${l.label}](import:${STUB(title)})`;
      }
      body = body.slice(0, l.at) + replacement + body.slice(l.at + l.raw.length);
    }

    // `#Tag` becomes the form Hermes reads. The word stays visible; the tag is
    // absorbed on write by the block route's own tag sync, which looks for
    // `(tag:)` links and nothing else in a body.
    body = rewriteTags(body);
    for (const t of n.tags) allTags.add(t);

    // Front matter stays, fenced. Left bare it is a thematic break followed by
    // a stray paragraph; fenced it is legible and still byte-for-byte there.
    const front = n.frontmatter.trim() ? `\`\`\`yaml\n${n.frontmatter.trim()}\n\`\`\`\n\n` : "";

    planned.push({
      key: n.path,
      kind: "note",
      title: n.title,
      body: `${n.title}\n\n${front}${body.trim()}`,
      tags: n.tags,
      attach: [...new Set(attach)],
      excerpt: n.excerpt,
      linkCount: n.links.length,
      sourcePath: n.path,
    });
    for (const p of new Set(attach)) files.push({ path: p, host: n.path });
  }

  for (const [key, title] of stubs) {
    planned.push({
      key, kind: "stub", title, body: title, tags: [], attach: [],
      excerpt: "", linkCount: 0,
    });
  }
  // A file several notes point at needs one owner, and picking one of them
  // would be arbitrary — so it gets a note of its own, named after the file.
  // Somewhere to find it, tag it, and say what it is; every note that mentions
  // it still shows it inline, pointing at this single copy.
  for (const path of shared) {
    const key = FILE(path);
    const title = stripExt(baseOf(path));
    const img = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(path);
    planned.push({
      key, kind: "file", title,
      body: `${title}\n\n${img ? "!" : ""}[${baseOf(path)}](attach:${path})`,
      tags: [], attach: [path],
      excerpt: `${fileRefs.get(path)?.size ?? 0} notes reference this file`,
      linkCount: 0,
    });
    files.push({ path, host: key });
  }

  // What Obsidian said that Hermes says differently — or cannot say at all.
  const q = notes.reduce(
    (a, n) => ({
      blockAnchors: a.blockAnchors + n.quirks.blockAnchors,
      callouts: a.callouts + n.quirks.callouts,
      comments: a.comments + n.quirks.comments,
      highlights: a.highlights + n.quirks.highlights,
      tables: a.tables + n.quirks.tables,
    }),
    { blockAnchors: 0, callouts: 0, comments: 0, highlights: 0, tables: 0 },
  );
  if (q.tables) {
    warnings.push(
      `${q.tables} markdown table${q.tables === 1 ? "" : "s"} will not survive. Hermes' note editor has no table, so one is dropped rather than shown — the only import loss here that cannot be undone by editing afterwards.`,
    );
  }
  if (q.callouts) {
    warnings.push(
      q.callouts === 1
        ? "1 callout becomes a quote led by its kind in bold."
        : `${q.callouts} callouts become quotes led by their kind in bold.`,
    );
  }
  if (q.comments) {
    warnings.push(`${q.comments} %%comment%%${q.comments === 1 ? " is" : "s are"} dropped — they are invisible in Obsidian, so showing them would be a change rather than a copy.`);
  }
  if (q.highlights) warnings.push(`${q.highlights} ==highlight${q.highlights === 1 ? "" : "s"}== become bold.`);
  if (q.blockAnchors) {
    warnings.push(`${q.blockAnchors} block anchor${q.blockAnchors === 1 ? "" : "s"} (\`^a1b2c3\`) are removed — they address a paragraph inside the vault and name nothing here.`);
  }

  const stubCount = stubs.size;
  if (stubCount) {
    warnings.push(
      `${stubCount} link${stubCount === 1 ? "" : "s"} point somewhere outside this folder or at nothing at all. Each becomes an empty note with that title, so the link survives and the note is one click from being written.`,
    );
  }
  if (shared.size) {
    warnings.push(
      `${shared.size} file${shared.size === 1 ? " is" : "s are"} referenced by more than one note. Each is stored once, on a note of its own, and shown inline everywhere it appears.`,
    );
  }
  if (ambiguous) {
    warnings.push(
      `${ambiguous} link${ambiguous === 1 ? " matches" : "s match"} more than one file by name. The shallowest path wins, which is the rule Obsidian uses.`,
    );
  }
  return { notes: planned, files, tags: [...allTags].sort(), warnings };
}

/**
 * `#Tag` → `[Tag](tag:tag)`, outside code.
 *
 * Not a cosmetic change: Hermes reads bare `#tag` only in a title or a
 * single-line text field, and reads a body for `(tag:)` links alone. A note
 * imported with its hashtags left as written would show them and file itself
 * under none of them.
 */
export function rewriteTags(body: string): string {
  const masked = maskCode(body);
  let out = "";
  let last = 0;
  for (const m of masked.matchAll(HASHTAG)) {
    const name = flattenTag(m[2] ?? "");
    if (!name) continue;
    const at = m.index + (m[1] ?? "").length;
    out += body.slice(last, at) + `[${m[2]}](tag:${name})`;
    last = at + 1 + (m[2] ?? "").length;
  }
  return out + body.slice(last);
}
