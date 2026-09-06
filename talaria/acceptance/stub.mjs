/**
 * A stand-in for a producer: just enough for the daemon to be exercised against,
 * and — crucially — something that can be killed mid-scenario.
 *
 * **It speaks pkm-interchange**, which is what the daemon speaks. It once
 * answered Hermes' private routes — `/sync/blocks`, `/sync/changes`, `/blocks` —
 * and the daemon moved onto the binding without it, so every step of the
 * scenario that reads or writes through the format printed "this producer does
 * not implement GET /interchange" and the run carried on to its cheerful "done".
 * The old routes are kept below because nothing is served by removing them, but
 * the interchange ones are the ones under test.
 *
 * It is deliberately *not* Hermes. A stub that answered the way Hermes does
 * would prove the daemon works against Hermes; the question this scenario asks
 * is whether it works against a producer, and the difference is the whole point
 * of the format.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY = "probe-key";
const STORE = process.env.STUB_STORE;
// Persisted, because the point of the exercise is to kill this process and
// bring it back with everything it had.
const state = existsSync(STORE)
  ? (() => { const d = JSON.parse(readFileSync(STORE, "utf8"));
             return { blocks: new Map(d.blocks.map((b) => [b.id, b])), changes: d.changes, seq: d.seq }; })()
  : { blocks: new Map(), changes: [], seq: 0 };
const save = () => writeFileSync(STORE, JSON.stringify({ blocks: [...state.blocks.values()], changes: state.changes, seq: state.seq }));

const TASK_TYPE = "11111111-1111-4111-8111-111111111111";
const TEXT_TYPE = "22222222-2222-4222-8222-222222222222";
const types = [
  { id: TASK_TYPE, name: "Task", isText: false, builtin: true,
    propertySchema: { fields: [
      { key: "title", type: "text", order: 0, includeEmbed: true },
      { key: "description", type: "longtext", order: 1, includeEmbed: true },
      { key: "schedule", type: "datespan", order: 2, includeEmbed: false, startLabel: "Available", endLabel: "Due" },
      { key: "status", type: "status", order: 3, includeEmbed: false, options: ["not_done","done"], optionLabels: { not_done: "Not done" } },
    ], status_field: "status", complete_values: ["done"], default_value: "not_done" } },
  { id: TEXT_TYPE, name: "text", isText: true, builtin: true, propertySchema: null },
];

/** One block, as the format says it. */
function asObject(b) {
  return {
    id: b.id,
    type: b.blockTypeId ?? undefined,
    properties: b.properties ?? {},
    ...(b.content != null ? { content: b.content } : {}),
    tags: b.tags ?? [],
    archived: Boolean(b.archivedAt),
    created: b.createdAt,
    updated: b.updatedAt,
    version: b.version,
    url: `http://127.0.0.1:58080/block/${b.id}`,
  };
}

/**
 * One type, as the format says it — fields and profiles rather than a schema.
 *
 * The profiles are the point: they are how a consumer knows which field holds a
 * title, which holds a body, and what "done" means here, without knowing
 * anything about this producer. A stub that skipped them would be testing a
 * consumer against a producer it already understood.
 */
function asType(t) {
  const fields = (t.propertySchema?.fields ?? []).map((f) => ({
    key: f.key,
    label: f.key === "title" ? "Title" : f.key[0].toUpperCase() + f.key.slice(1),
    kind: { text: "text", longtext: "richtext", datespan: "datespan", status: "enum" }[f.type] ?? "text",
    ...(f.options ? { options: f.options } : {}),
  }));
  const profiles = {};
  if (t.propertySchema?.status_field) {
    profiles.task = {
      title: "title",
      due: { field: "schedule", part: "end" },
      status: t.propertySchema.status_field,
      completeValues: t.propertySchema.complete_values ?? ["done"],
    };
  }
  if (t.isText) profiles.note = { body: "content" };
  else profiles.note = { title: "title", body: "description" };
  return { id: t.id, name: t.name, fields, profiles };
}

function log(op, id, version) {
  state.changes.push({ seq: ++state.seq, blockId: id, op, version: version ?? null, at: new Date().toISOString() });
}
function put(b) { state.blocks.set(b.id, b); }
function mk({ id = randomUUID(), typeId = TASK_TYPE, content = null, properties = {}, tags = [] }) {
  const now = new Date().toISOString();
  const b = { id, blockTypeId: typeId, collectionKind: null, content, properties,
    version: 1, archivedAt: null, createdAt: now, updatedAt: now, tags };
  put(b); log("insert", id, 1); save();
  return b;
}

if (!state.blocks.size) {
  mk({ properties: { title: "Fix the roof", status: "not_done", schedule: { start: "2026-08-20", end: "2026-08-25" } }, tags: ["house"] });
  mk({ properties: { title: "Call the accountant", status: "not_done" } });
  mk({ typeId: TEXT_TYPE, content: "# Thursday\n\nsome earlier writing", properties: { today_note: "2026-08-22" } });
}
save();

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // `/conformance` is unauthenticated on purpose — see the route below.
  if (!url.pathname.replace(/^\/api/, "").startsWith("/conformance")
      && req.headers.authorization !== `Bearer ${KEY}`) {
    return json(res, 401, { error: "unauthorized" });
  }
  const p = url.pathname.replace(/^\/api/, "");
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : undefined;

    /* ---------------------------------------------------------- interchange */

    // Unauthenticated by design: a 401 here would say nothing about the network,
    // and the daemon uses this to answer "is the far end there".
    if (p === "/conformance") {
      return json(res, 200, {
        format: "pkm-interchange/0",
        producer: { name: "acceptance-stub", version: "1.0.0" },
        conformance: {
          produce: 2, consume: 1, operate: 1,
          bindings: ["http"],
          profiles: ["task", "note"],
          features: ["cursor"],
          unsupported: ["attachments", "series", "relations"],
        },
      });
    }

    if (p === "/interchange" && req.method === "GET") {
      // `since` is this producer's own cursor and nothing else — the daemon
      // never parses it, which is what lets it be a sequence number here.
      const since = url.searchParams.get("since");
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const all = [...state.blocks.values()];
      const moved = since === null
        ? all
        : all.filter((b) => {
            const at = state.changes.filter((c) => c.blockId === b.id).pop();
            return at ? at.seq > Number(since) : false;
          });
      const found = q
        ? moved.filter((b) =>
            JSON.stringify(b.properties ?? {}).toLowerCase().includes(q) ||
            (b.content ?? "").toLowerCase().includes(q))
        : moved;
      return json(res, 200, {
        format: "pkm-interchange/0",
        cursor: String(state.seq),
        producer: { name: "acceptance-stub", version: "1.0.0" },
        conformance: { produce: 2, consume: 1, operate: 1, bindings: ["http"], profiles: ["task", "note"] },
        types: types.map(asType),
        objects: found.map(asObject),
        collections: [],
      });
    }

    const object = p.match(/^\/interchange\/objects\/([0-9a-fA-F-]{36})$/);

    if (object && req.method === "PUT") {
      /*
       * Idempotent by the id, which is the property the whole offline story
       * rests on: the daemon decides an id before it writes, so a create that
       * was sent twice — because the answer went missing, not because anybody
       * asked twice — is recognizably the same create.
       *
       * `created: false` is how that is said. Inferring it from a version number
       * is what the daemon used to do and what its own comment calls wrong.
       */
      const already = state.blocks.get(object[1]);
      if (already) return json(res, 200, { ok: true, created: false, object: asObject(already) });
      const typeId = parsed?.type ?? TEXT_TYPE;
      const isText = types.find((t) => t.id === typeId)?.isText ?? false;
      const made = mk({
        id: object[1], typeId,
        content: isText ? (parsed?.content ?? "") : (parsed?.content ?? null),
        properties: isText ? {} : (parsed?.properties ?? {}),
      });
      return json(res, 201, { ok: true, created: true, object: asObject(made) });
    }

    if (object && req.method === "PATCH") {
      const b = state.blocks.get(object[1]);
      if (!b) return json(res, 404, { ok: false, error: "no such object" });
      // A version that has moved on is a conflict, not a silent overwrite.
      if (parsed?.version !== undefined && parsed.version !== b.version) {
        return json(res, 409, { ok: false, conflict: true, object: asObject(b) });
      }
      if (parsed?.content !== undefined) b.content = parsed.content;
      if (parsed?.properties !== undefined) b.properties = { ...b.properties, ...parsed.properties };
      b.version += 1;
      b.updatedAt = new Date().toISOString();
      log("update", b.id, b.version); save();
      return json(res, 200, { ok: true, cursor: String(state.seq), object: asObject(b) });
    }

    /* --------------------------------------------- the producer's own routes */

    if (p === "/block-types") return json(res, 200, types);

    if (p === "/sync/blocks") {
      const head = state.seq;
      const ids = url.searchParams.get("ids");
      const all = [...state.blocks.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
      if (ids) {
        const want = new Set(ids.split(","));
        return json(res, 200, { blocks: all.filter((b) => want.has(b.id)), seq: head, next: null });
      }
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const page = all.filter((b) => !after || b.id > after).slice(0, limit);
      return json(res, 200, { blocks: page, seq: head,
        next: page.length === limit ? page[page.length - 1].id : null });
    }

    if (p === "/sync/changes") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const rows = state.changes.filter((c) => c.seq > since);
      return json(res, 200, { changes: rows, nextSeq: rows.length ? rows[rows.length - 1].seq : since,
        more: false, pruned: false });
    }

    if (p === "/blocks" && req.method === "POST") {
      const id = parsed.id ?? randomUUID();
      const existing = state.blocks.get(id);
      if (existing) return json(res, 200, existing);   // idempotent, as core now is
      // Faithful to Hermes: a missing type resolves to *text*, and a text type
      // keeps its body in content and discards properties entirely.
      const typeId = parsed.blockTypeId ?? TEXT_TYPE;
      const isText = types.find((t) => t.id === typeId)?.isText ?? false;
      return json(res, 201, mk({ id, typeId,
        content: isText ? (parsed.content ?? "") : null,
        properties: isText ? {} : (parsed.properties ?? {}) }));
    }

    const patch = p.match(/^\/blocks\/([0-9a-f-]{36})$/);
    if (patch && req.method === "PATCH") {
      const b = state.blocks.get(patch[1]);
      if (!b) return json(res, 404, { error: "not found" });
      if (parsed.version !== b.version) return json(res, 409, { error: "version conflict" });
      if (parsed.content !== undefined) b.content = parsed.content;
      if (parsed.properties !== undefined) b.properties = parsed.properties;
      b.version += 1;
      b.updatedAt = new Date().toISOString();
      log("update", b.id, b.version); save();
      return json(res, 200, b);
    }

    const note = p.match(/^\/today\/(\d{4}-\d{2}-\d{2})\/note$/);
    if (note) {
      let n = [...state.blocks.values()].find((b) => b.properties?.today_note === note[1]);
      if (!n) n = mk({ typeId: TEXT_TYPE, content: "", properties: { today_note: note[1] } });
      return json(res, 200, n);
    }

    return json(res, 404, { error: `stub has no ${req.method} ${p}` });
  });
}).listen(58080, "127.0.0.1", () => console.log("stub up"));
