#!/usr/bin/env -S npx tsx
import type { CanonicalBlock } from "@talaria/canonical";
import { call, DaemonDown, SOCKET } from "./client.js";
import { dim, warn } from "./format.js";

/**
 * `hermes` — the command-line face of the mirror.
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
  const VALUED = new Set(["kind", "limit", "type", "date", "retry", "drop"]);
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

function usage(): void {
  console.log(`hermes — Hermes Notes from the command line (served from the local mirror)

  hermes find [text] [--kind task|note|event|person|project|organization]
                     [--archived] [--limit N]
  hermes show <id>
  hermes add <title...> [--type <uuid>] [--note]   create a task (or a note with --note)
  hermes done <id>                                  mark a task complete
  hermes note <text...> [--date YYYY-MM-DD]         append to a daily note
  hermes queue [--retry <id>] [--drop <id>]         writes waiting on the network
  hermes sync                                       ask for a sync right now
  hermes status                                     what the daemon knows
  hermes doctor                                     check everything that fails quietly

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
            `   ${warn(`stopped: ${r.parkedReason}`)} — hermes queue --retry ${r.id}, or --drop ${r.id}`,
          );
      }
      return 0;
    }

    case "sync": {
      const r = await call<{ sync: { state: string; changed?: number; detail?: string } }>("POST", "/sync");
      console.log(
        r.sync.state === "ok"
          ? `synced — ${r.sync.changed ?? 0} block(s) changed`
          : warn(`${r.sync.state}: ${r.sync.detail ?? ""}`),
      );
      return r.sync.state === "ok" ? 0 : 1;
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
  console.error(`hermes: ${(err as Error).message}`);
  process.exit(1);
}
