#!/usr/bin/env -S npx tsx
import type { CanonicalBlock } from "@talaria/canonical";
import { call, DaemonDown, SOCKET } from "./client.js";
import { dim, warn } from "./format.js";
import {
  ADDRESSES,
  frontmostBundleId,
  render,
  styleFor,
  SYNTAXES,
  type Address,
  type LinkStyle,
  type Syntax,
} from "./link.js";

/**
 * `talaria` — the command-line face of the mirror.
 *
 * Every read is answered from local SQLite by the daemon, so all of this works
 * with the machine entirely off the network. What changes offline is that
 * answers are stamped with their age, and writes say they have been queued.
 */

interface Envelope<T> {
  data: T;
  freshness: "never" | "fresh" | "stale" | "cold";
  syncedAt: string | null;
  note: string;
}

/** Age is never hidden, but a fresh mirror needn't keep saying so. */
function footer(env: Envelope<unknown>): void {
  if (env.freshness === "fresh") return;
  const line = `— ${env.note}`;
  console.log(env.freshness === "stale" ? dim(line) : warn(line));
}

function line(b: CanonicalBlock): string {
  const bits: string[] = [];
  if (b.completion) bits.push(b.completion.done ? "[x]" : "[ ]");
  bits.push(b.title);
  const meta: string[] = [b.kind];
  if (b.schedule?.end) meta.push(`${b.schedule.endLabel ?? "due"} ${b.schedule.end.value}`);
  else if (b.schedule?.start) meta.push(b.schedule.start.value);
  if (b.tags.length) meta.push(b.tags.map((t) => `#${t}`).join(" "));
  if (b.archivedAt) meta.push("archived");
  return `${bits.join(" ")}  ${dim(`(${meta.join(" · ")})`)}`;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Flags with values, flags without, and everything left over as words. */
function parse(args: string[]): { words: string[]; flags: Map<string, string | true> } {
  const VALUED = new Set([
    "kind", "limit", "type", "date", "retry", "drop", "as", "address", "for", "app", "title", "workspace", "block",
  ]);
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      words.push(a);
      continue;
    }
    const name = a.slice(2);
    if (VALUED.has(name)) {
      flags.set(name, args[++i] ?? "");
    } else {
      flags.set(name, true);
    }
  }
  return { words, flags };
}

/** What the daemon thinks you were working in, when nobody told us. */
async function workingApp(): Promise<string | undefined> {
  try {
    const res = await call<{ working: { app: string | null } | null }>("GET", "/context?limit=1");
    return res.working?.app ?? undefined;
  } catch {
    // Recording off, daemon busy, table empty — all the same answer here, which
    // is "take the default". A picker must never fail because it could not
    // guess a formatting preference.
    return undefined;
  }
}

function usage(): void {
  console.log(`talaria — Hermes Notes from the command line (served from the local mirror)

  talaria find [text] [--kind task|note|event|person|project|organization]
                     [--archived] [--limit N]
  talaria show <id>
  talaria add <title...> [--type <uuid>] [--note]   create a task (or a note with --note)
  talaria done <id>                                  mark a task complete
  talaria note <text...> [--date YYYY-MM-DD]         append to a daily note
  talaria queue [--retry <id>] [--drop <id>]         writes waiting on the network
  talaria sync [--full]                              sync now; --full re-walks everything
  talaria status                                     what the daemon knows
  talaria doctor                                     check everything that fails quietly
  talaria alfred <text>                              Alfred Script Filter JSON
  talaria alfred --link <text>                       ...whose result is a link to paste
  talaria link <text> [--as markdown|wiki|bare|title] [--address share|here]
                      [--for <bundle-id>] [--copy]   a link to a block, for pasting
  talaria glance [text] [--limit N]                  what the library knows about what you are looking at
  talaria glance --index                             build the local index now
  talaria context [--limit N]                        what the machine has been doing
  talaria context set [--app ID] [--title T] [--workspace W]
  talaria context off | on                           off also forgets everything held
  talaria open <text>                                open the best match in the browser
  talaria capture [text] [--note]                    text -> a task (or a note with --note)

Reads never touch the network. Writes go out when they can and queue when they can't.
Socket: ${SOCKET}`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { words, flags } = parse(rest);
  const str = (n: string): string | undefined => {
    const v = flags.get(n);
    return typeof v === "string" ? v : undefined;
  };

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;

    case "find": {
      const q = new URLSearchParams();
      const text = words.join(" ").trim();
      if (text) q.set("q", text);
      if (str("kind")) q.set("kind", str("kind")!);
      if (flags.has("archived")) q.set("archived", "true");
      if (str("limit")) q.set("limit", str("limit")!);
      const env = await call<Envelope<CanonicalBlock[]>>("GET", `/blocks?${q}`);
      if (!env.data.length) console.log(dim("nothing matched"));
      for (const b of env.data) console.log(line(b));
      footer(env);
      return 0;
    }

    case "show": {
      const id = words[0];
      if (!id) {
        console.error("which one?");
        return 2;
      }
      const env = await call<Envelope<CanonicalBlock>>("GET", `/blocks/${id}`);
      const b = env.data;
      console.log(b.title);
      console.log(dim(`${b.kind}${b.typeName ? ` · ${b.typeName}` : ""} · ${b.url}`));
      if (b.completion) console.log(`status: ${b.completion.label}${b.completion.done ? " ✓" : ""}`);
      if (b.schedule?.start) console.log(`${b.schedule.startLabel ?? "start"}: ${b.schedule.start.value}`);
      if (b.schedule?.end) console.log(`${b.schedule.endLabel ?? "end"}: ${b.schedule.end.value}`);
      if (b.recurrence)
        console.log(
          `repeats: every ${b.recurrence.interval} ${b.recurrence.frequency}` +
            ` (anchored to ${b.recurrence.anchor}` +
            `${b.recurrence.occurrence ? `, #${b.recurrence.occurrence}` : ""})`,
        );
      if (b.tags.length) console.log(`tags: ${b.tags.map((t) => `#${t}`).join(" ")}`);
      if (b.body) console.log(`\n${b.body}`);
      footer(env);
      return 0;
    }

    case "add": {
      const title = words.join(" ").trim();
      if (!title) {
        console.error("what should it be called?");
        return 2;
      }
      const typeId = str("type");
      const res = await call<{ applied: boolean; id?: string; queued?: number; note?: string }>(
        "POST",
        "/write",
        {
          kind: "create",
          ...(flags.has("note") ? { content: title } : { properties: { title } }),
          ...(typeId ? { blockTypeId: typeId } : {}),
        },
      );
      console.log(res.applied ? `created ${res.id}` : warn(`queued as ${res.id} — ${res.note}`));
      return 0;
    }

    case "done": {
      const id = words[0];
      if (!id) {
        console.error("which one?");
        return 2;
      }
      const res = await call<{ applied: boolean; note?: string }>("POST", "/write", {
        kind: "complete",
        blockId: id,
      });
      console.log(res.applied ? "done" : warn(`queued — ${res.note}`));
      return 0;
    }

    case "note": {
      const text = words.join(" ").trim();
      if (!text) {
        console.error("what should it say?");
        return 2;
      }
      const date = str("date") ?? today();
      const res = await call<{ applied: boolean; date?: string; note?: string }>("POST", "/write", {
        kind: "append",
        date,
        text,
      });
      console.log(res.applied ? `added to ${date}` : warn(`queued — ${res.note}`));
      return 0;
    }

    case "queue": {
      if (str("retry")) {
        await call("POST", `/queue/${str("retry")}/retry`);
        console.log("retried");
        return 0;
      }
      if (str("drop")) {
        await call("DELETE", `/queue/${str("drop")}`);
        console.log("dropped");
        return 0;
      }
      const rows = await call<
        {
          id: number;
          kind: string;
          intent: Record<string, unknown>;
          createdAt: string;
          parkedReason: string | null;
          attempts: number;
        }[]
      >("GET", "/queue");
      if (!rows.length) {
        console.log(dim("nothing waiting"));
        return 0;
      }
      for (const r of rows) {
        const what =
          r.kind === "append"
            ? `append to ${String(r.intent.date)}: ${JSON.stringify(r.intent.text)}`
            : r.kind === "complete"
              ? `complete ${String(r.intent.blockId)}`
              : `create ${String(r.intent.id)}`;
        console.log(`${r.id}. ${what}  ${dim(`(${new Date(r.createdAt).toLocaleString()})`)}`);
        if (r.parkedReason)
          console.log(
            `   ${warn(`stopped: ${r.parkedReason}`)} — talaria queue --retry ${r.id}, or --drop ${r.id}`,
          );
      }
      return 0;
    }

    case "sync": {
      const r = await call<{ sync: { state: string; changed?: number; detail?: string } }>(
        "POST",
        flags.has("full") ? "/sync?full=true" : "/sync",
      );
      console.log(
        r.sync.state === "ok"
          ? `synced — ${r.sync.changed ?? 0} block(s) changed`
          : warn(`${r.sync.state}: ${r.sync.detail ?? ""}`),
      );
      return r.sync.state === "ok" ? 0 : 1;
    }

    /**
     * Alfred's Script Filter format.
     *
     * Alfred searches the file metadata index, and CoreSpotlight items are not
     * in it — the two stores are separate, which is why ⌘Space finds a block
     * and Alfred cannot. So Alfred is fed directly rather than through the
     * system index.
     *
     * The `arg` is the https link rather than `talaria://`. The scheme exists to
     * keep *written down* links working after Hermes moves; a launcher resolves
     * fresh on every keystroke, so it has no stale links to protect and is
     * better off with the address that works unconditionally.
     */
    case "alfred": {
      const q = new URLSearchParams();
      const text = words.join(" ").trim();
      if (text) q.set("q", text);
      q.set("limit", "25");
      // The frontmost application is a launcher by the time this runs — that is
      // what a picker *is* — so asking the system returns the question rather
      // than the answer. The daemon's context record holds the last thing that
      // wasn't a launcher, which is exactly what was wanted, and `--for` still
      // wins for a caller that knows better.
      const linking = flags.has("link");
      const style = linking ? styleFor(str("for") ?? (await workingApp())) : null;
      try {
        const env = await call<Envelope<CanonicalBlock[]>>("GET", `/blocks?${q}`);
        const stale = env.freshness !== "fresh" ? ` · ${env.note}` : "";
        const items = env.data.map((b) => ({
          uid: b.id,
          title: b.title,
          subtitle: linking
            ? `${render(b, style!)}${stale}`
            : [
                `Hermes ${b.typeName}`,
                b.completion?.done ? "done" : null,
                b.tags.map((t) => `#${t}`).join(" ") || null,
              ]
                .filter(Boolean)
                .join("  ·  ") + stale,
          arg: linking ? render(b, style!) : b.url,
          // Alfred keys its own ranking off this when told to.
          match: `${b.title} ${b.typeName} ${b.tags.join(" ")}`,
          valid: true,
          mods: linking
            ? {
                // The other address, and the bare title — the two things you
                // reach for when the guess was wrong, without reopening
                // anything.
                cmd: {
                  arg: render(b, { ...style!, address: style!.address === "here" ? "share" : "here" }),
                  subtitle: style!.address === "here" ? "Shareable https link" : "talaria:// (survives a move)",
                },
                alt: { arg: b.title, subtitle: "Just the title" },
              }
            : { cmd: { arg: b.appUrl, subtitle: "Open via talaria:// (host-independent)" } },
        }));
        console.log(JSON.stringify({ items }));
      } catch (err) {
        // A Script Filter has nowhere to put an error but the result list, and
        // an empty list would read as "no matches" rather than "nothing asked".
        console.log(
          JSON.stringify({
            items: [{ title: "Talaria isn't answering", subtitle: (err as Error).message, valid: false }],
          }),
        );
      }
      return 0;
    }

    /**
     * What the machine has been doing, lately.
     *
     * `set` records a moment; bare shows everything held; `off` stops and
     * forgets. Kept on one command because the audit and the switch belong next
     * to the thing they govern — a record you can write to but not read is one
     * nobody can consent to.
     */
    case "glance": {
      if (flags.has("index")) {
        const r = await call<{ embedded: number; left: number }>("POST", "/glance/index");
        console.log(`embedded ${r.embedded}, ${r.left ? `${r.left} left` : "up to date"}`);
        return 0;
      }
      const q = new URLSearchParams();
      const text = words.join(" ").trim();
      if (text) q.set("q", text);
      if (str("limit")) q.set("k", str("limit")!);
      const res = await call<{
        data: { score: number; block: { title: string; kind: string; completion: unknown; url: string } }[];
        question: string | null;
        error?: string;
      }>("GET", `/glance${q.toString() ? `?${q}` : ""}`);

      if (res.error) {
        console.log(warn("no answer") + dim(` — ${res.error}`));
        return 1;
      }
      if (!res.question) {
        console.log(dim("nothing in front worth asking about"));
        return 0;
      }
      console.log(dim(`near: ${res.question}`));
      if (!res.data.length) {
        console.log(dim("nothing close. `talaria glance --index` if this is the first run."));
        return 0;
      }
      console.log("");
      for (const hit of res.data) {
        const done = (hit.block.completion as { done?: boolean } | null)?.done;
        const box = done === undefined ? "  " : done ? "[x]" : "[ ]";
        console.log(`  ${dim(hit.score.toFixed(2))} ${box} ${hit.block.title.slice(0, 64)}`);
      }
      return 0;
    }

    case "context": {
      const sub = words[0];

      if (sub === "set") {
        // Rift's contribution is the workspace, and only the workspace. It has
        // no bundle id to give — the sole app identity in its payload is a pid
        // inside `RIFT_WINDOW_ID` — and its title stream is mostly noise, since
        // a terminal retitles itself on every command it runs. The daemon polls
        // for the frontmost application itself.
        //
        //   rift-cli subscribe cli --event workspace_changed \
        //     --command talaria --args context set
        const res = await call<{ recorded: boolean; row?: Record<string, unknown>; why?: string }>(
          "POST",
          "/context",
          {
            app: str("app") ?? null,
            title: str("title") ?? null,
            workspace: str("workspace") ?? process.env.RIFT_WORKSPACE_NAME ?? null,
            block: str("block") ?? null,
          },
        );
        if (!res.recorded) console.log(dim(`not recorded — ${res.why}`));
        else if (res.why) console.log(dim(res.why));
        return 0;
      }

      if (sub === "off") {
        const res = await call<{ forgotten: number }>("DELETE", "/context");
        console.log(`recording off — forgot ${res.forgotten} row(s)`);
        return 0;
      }

      if (sub === "on") {
        await call("POST", "/context/on");
        console.log("recording on");
        return 0;
      }

      const res = await call<{
        recording: boolean;
        windowHours: number;
        excluded: string[];
        working: { at: string; app: string | null; title: string | null; workspace: string | null; block: string | null } | null;
        recent: { at: string; app: string | null; title: string | null; workspace: string | null; block: string | null }[];
      }>("GET", `/context?limit=${str("limit") ?? "50"}`);

      if (!res.recording) {
        console.log(warn("recording is off") + dim(" — talaria context on"));
        return 0;
      }
      console.log(
        dim(
          `keeping ${res.windowHours}h, on this machine only` +
            (res.excluded.length ? `, excluding ${res.excluded.join(", ")}` : ""),
        ),
      );
      if (res.working) {
        const w = res.working;
        console.log(`working in: ${w.app ?? "?"}${w.workspace ? ` · ${w.workspace}` : ""}`);
        if (w.title) console.log(dim(`            ${w.title}`));
      }
      if (!res.recent.length) {
        console.log(dim("nothing recorded yet"));
        return 0;
      }
      console.log("");
      for (const r of res.recent) {
        const when = new Date(r.at).toLocaleTimeString();
        // A resolved block is shown as an arrow rather than as a title, because
        // that is exactly what it is: the name was looked up and thrown away,
        // and only the thing it pointed at was kept.
        const bits = [r.app ?? "?", r.workspace, r.title, r.block ? `→ ${r.block}` : null]
          .filter(Boolean)
          .join("  ·  ");
        console.log(`${dim(when)}  ${bits}`);
      }
      return 0;
    }

    /**
     * A link to a block, in the shape the destination wants.
     *
     * The reciprocal of `capture`, and the half that does not exist anywhere
     * yet: everything in this stack can turn text into a block, and nothing can
     * turn a block into a reference you can drop into a sentence somewhere else.
     *
     * Prints and does nothing more, by default. A command that writes to the
     * clipboard without being asked is one you cannot pipe, and piping is how
     * every other caller here works.
     *
     * **stdout carries the link and nothing else.** Freshness goes to stderr
     * rather than through `footer`, because this output is destined for a
     * clipboard or another command — a mirror-age note appended to it would be
     * pasted into somebody's email.
     */
    case "link": {
      const text = words.join(" ").trim();
      if (!text) {
        console.error("link to what?");
        return 2;
      }

      const asked = str("as");
      if (asked && !SYNTAXES.includes(asked as Syntax)) {
        console.error(`--as wants one of: ${SYNTAXES.join(", ")}`);
        return 2;
      }
      const addr = str("address");
      if (addr && !ADDRESSES.includes(addr as Address)) {
        console.error(`--address wants one of: ${ADDRESSES.join(", ")}`);
        return 2;
      }

      const env = await call<Envelope<CanonicalBlock[]>>(
        "GET",
        `/blocks?q=${encodeURIComponent(text)}&limit=1`,
      );
      const hit = env.data[0];
      if (!hit) {
        console.error(`nothing in Hermes matches "${text}"`);
        return 1;
      }

      // Explicit flags win over the guess. Failing that, the daemon knows what
      // you were in a moment ago; failing *that*, ask the system, which is right
      // whenever this is run straight from a shell.
      const guessed = styleFor(str("for") ?? (await workingApp()) ?? (await frontmostBundleId()));
      const style: LinkStyle = {
        syntax: (asked as Syntax) ?? guessed.syntax,
        address: (addr as Address) ?? guessed.address,
      };

      const out = render(hit, style);
      if (flags.has("copy")) {
        const { spawn } = await import("node:child_process");
        const pb = spawn("/usr/bin/pbcopy");
        pb.stdin.end(out);
        await new Promise((r) => pb.on("close", r));
        console.error(dim(`copied: ${out}`));
      } else {
        console.log(out);
      }
      if (env.freshness !== "fresh") console.error(dim(`— ${env.note}`));
      return 0;
    }

    /**
     * Find the best match and open it.
     *
     * Backs Alfred's fallback row, which is a single result rather than a list:
     * you typed something, nothing on the machine matched, and this is the one
     * block most likely to be what you meant.
     */
    case "open": {
      const text = words.join(" ").trim();
      if (!text) {
        console.error("open what?");
        return 2;
      }
      const env = await call<Envelope<CanonicalBlock[]>>("GET", `/blocks?q=${encodeURIComponent(text)}&limit=1`);
      const hit = env.data[0];
      if (!hit) {
        console.error(`nothing in Hermes matches "${text}"`);
        return 1;
      }
      const { spawn } = await import("node:child_process");
      spawn("/usr/bin/open", [hit.url], { detached: true, stdio: "ignore" }).unref();
      console.log(hit.title);
      return 0;
    }

    /**
     * Capture text as a task — from arguments, or from stdin when piped.
     *
     * The same call the Services menu makes, exposed so anything else can make
     * it too: a Shortcut, Keyboard Maestro, a pipe from another command.
     */
    case "capture": {
      const piped = !process.stdin.isTTY ? await new Promise<string>((res) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c: string) => (buf += c));
        process.stdin.on("end", () => res(buf));
      }) : "";
      const text = (words.join(" ").trim() || piped).trim();
      if (!text) {
        console.error("nothing to capture — pass text, or pipe it in");
        return 2;
      }
      const res = await call<{ applied: boolean; id?: string; title: string; storedProse: boolean; note?: string }>(
        "POST",
        "/capture",
        {
          text,
          as: flags.has("note") ? "note" : "task",
          ...(str("type") ? { blockTypeId: str("type") } : {}),
        },
      );
      const where = res.storedProse ? "" : dim(" (no prose field on that type — kept in the title)");
      console.log(`${res.applied ? "created" : warn("queued")}: ${res.title}${where}`);
      return 0;
    }

    case "doctor": {
      const r = await call<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>(
        "GET",
        "/doctor",
      );
      for (const c of r.checks) {
        const mark = c.ok ? "ok  " : "FAIL";
        console.log(`${c.ok ? mark : warn(mark)} ${c.name.padEnd(12)} ${c.detail}`);
      }
      return r.ok ? 0 : 1;
    }

    case "status": {
      const h = await call<Record<string, unknown>>("GET", "/health");
      for (const [k, v] of Object.entries(h)) console.log(`${k.padEnd(10)} ${String(v)}`);
      return h.freshness === "never" || h.freshness === "cold" ? 1 : 0;
    }

    default:
      console.error(`unknown command: ${cmd}`);
      usage();
      return 2;
  }
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (err) {
  if (err instanceof DaemonDown) {
    console.error(err.message);
    process.exit(69); // EX_UNAVAILABLE
  }
  console.error(`talaria: ${(err as Error).message}`);
  process.exit(1);
}
