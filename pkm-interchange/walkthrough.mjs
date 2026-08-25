/**
 * The whole protocol, once, end to end.
 *
 * Every payload below is real: a producer implementing the spec is started on a
 * socket, and a consumer walks from knowing nothing about it to marking one of
 * its tasks done and seeing the change come back. Nothing here is illustrative
 * — if the spec changes and this stops being true, the run fails.
 *
 *   node walkthrough.mjs
 */
import { createServer } from "node:http";

// ---- a producer, with its own vocabulary -----------------------------------
// It calls them Chores. Its title is in `what`, its due date in `by`, and it
// considers `sorted` and `abandoned` to be finished. A consumer will need to
// know none of that.

let cursor = 40;
const log = [];
const objects = [
  {
    id: "o_7", type: "chore", version: 2,
    properties: { what: "Bleed the radiators", by: "2026-09-01", state: "open", faff: 7 },
    created: "2026-08-01T09:00:00Z", updated: "2026-08-20T11:00:00Z",
  },
];
const TYPES = [{
  id: "chore",
  name: "Chore",
  fields: [
    { key: "what", kind: "text" },
    { key: "by", kind: "date", label: "Needed by" },
    { key: "state", kind: "enum", options: ["open", "sorted", "abandoned"] },
    { key: "faff", kind: "vendor:faff-o-meter" },
  ],
  profiles: {
    task: { title: "what", due: "by", status: "state", completeValues: ["sorted", "abandoned"] },
  },
}];
const CONFORMANCE = {
  produce: 4, consume: 0, operate: 4,
  bindings: ["http"], profiles: ["task"], features: [], unsupported: [],
};

const envelope = (only, changes) => ({
  format: "pkm-interchange/0",
  producer: { name: "chore-tracker", version: "1.0.0" },
  conformance: CONFORMANCE,
  cursor: String(cursor),
  types: TYPES,
  objects: only ? objects.filter((o) => only.has(o.id)) : objects,
  ...(changes ? { changes } : {}),
  findings: [],
});

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/conformance") return send(200, CONFORMANCE);
  if (url.pathname === "/interchange") {
    const since = url.searchParams.get("since");
    if (since !== null) {
      const rows = log.filter((r) => r.seq > Number(since));
      return send(200, envelope(new Set(rows.map((r) => r.object)),
        rows.map((r) => ({ object: r.object, op: r.op }))));
    }
    if (url.searchParams.get("profile")) {
      const ok = new Set(TYPES.filter((t) => t.profiles?.task).map((t) => t.id));
      return send(200, envelope(new Set(objects.filter((o) => ok.has(o.type)).map((o) => o.id))));
    }
    return send(200, envelope());
  }
  const m = /^\/interchange\/objects\/(.+)$/.exec(url.pathname);
  if (m && req.method === "PATCH") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const patch = JSON.parse(body);
      const o = objects.find((x) => x.id === m[1]);
      if (patch.version !== o.version) {
        return send(409, { ok: false, conflict: true, reports: ["version.stale"] });
      }
      Object.assign(o.properties, patch.set ?? {});
      for (const k of patch.unset ?? []) delete o.properties[k];
      // The producer does something the caller never asked for. This is the
      // reason a write answers with the object.
      o.properties.finished_on = "2026-08-25";
      o.version += 1;
      o.updated = "2026-08-25T20:00:00Z";
      log.push({ seq: ++cursor, object: o.id, op: "update" });
      send(200, {
        ok: true, fidelity: "full", reports: [],
        cursor: String(cursor), object: o,
      });
    });
    return;
  }
  send(404, {});
});

// ---- a consumer that has never heard of a Chore ----------------------------

await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}`;
let step = 0;
const show = (title, note, req, body) => {
  console.log(`\n${"─".repeat(74)}\n${++step}. ${title}\n${"─".repeat(74)}`);
  if (note) console.log(`${note}\n`);
  console.log(`  → ${req}`);
  if (body !== undefined) console.log(JSON.stringify(body, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
};
const out = (o) => console.log(`  ← ${JSON.stringify(o, null, 2).split("\n").join("\n  ")}`);
const get = async (p) => (await fetch(base + p)).json();

show("Ask what it can do", "No credentials. A client deciding whether it can talk to this at all should not need an account to find out — and an agent that must attempt a write to learn whether writes exist has already done the damage if they do not.", "GET /conformance");
const said = await get("/conformance");
out(said);
console.log(`\n  It operates, over http, and one of its types is a task.`);
console.log(`  If profiles were ["contact"] we would stop here: this is an address book.`);

show("Ask for the tasks", "`?profile=task` is permission to send less, not an obligation. The types travel whichever way it answers — an object whose type was filtered out is unreadable, and the format makes that a rule.", "GET /interchange?profile=task");
const env = await get("/interchange?profile=task");
out({ cursor: env.cursor, types: env.types.map((t) => ({ id: t.id, profiles: Object.keys(t.profiles ?? {}) })), objects: env.objects });

show("Read one, through the profile", "The consumer knows what a `task` is. It has never heard of a Chore, of `what`, or of `by` — and does not need to.", "(no request — this is arithmetic on what came back)");
const type = new Map(env.types.map((t) => [t.id, t]))
  .get(env.objects[0].type);
const map = type.profiles.task;
const obj = env.objects[0];
const read = (slot) => obj.properties[map[slot]];
console.log(`
    profiles.task.title  = ${JSON.stringify(map.title)}   →  properties.${map.title}  = ${JSON.stringify(read("title"))}
    profiles.task.due    = ${JSON.stringify(map.due)}     →  properties.${map.due}    = ${JSON.stringify(read("due"))}
    profiles.task.status = ${JSON.stringify(map.status)}  →  properties.${map.status} = ${JSON.stringify(read("status"))}
    completeValues       = ${JSON.stringify(map.completeValues)}

  Is it done?  ${JSON.stringify(map.completeValues.includes(read("status")))}   — because "${read("status")}" is not in that list.
  Note what the consumer never did: look at the type's name, or guess that a
  field called "by" might be a date. Two hops, both stated by the producer.`);

show("Mark it done", `Which value means done is the producer's to say, and it said: ${JSON.stringify(map.completeValues)}. Take the first.

Two keys and no third. \`faff\` is a field this consumer has no idea about, is not mentioned, and must come back untouched — that is the round-trip rule at write time, and it is the half that gets skipped.

\`version\` is the one the read carried. A stale one is refused rather than merged.`,
  `PATCH /interchange/objects/${obj.id}`,
  { set: { [map.status]: map.completeValues[0] }, version: obj.version });
const answer = await (await fetch(`${base}/interchange/objects/${obj.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ set: { [map.status]: map.completeValues[0] }, version: obj.version }),
})).json();
out(answer);
console.log(`
  Three things in that answer worth naming:

    fidelity "full"   it stored everything. Said honestly, so it means something
                      — a tool that reports "reduced" defensively has taught its
                      users to ignore the one report that mattered.
    object            the object as it now stands, including \`finished_on\`, which
                      the producer stamped and nobody asked for. Applying this is
                      what makes the echo in step 5 a no-op.
    cursor            where the write landed.

  And \`faff\` is still ${JSON.stringify(answer.object.properties.faff)}.`);

show("A stale write, refused", "The same patch again, presenting the version we read at the start. Somebody else has moved since — in this case us.", `PATCH /interchange/objects/${obj.id}`, { set: { [map.status]: "open" }, version: obj.version });
const stale = await (await fetch(`${base}/interchange/objects/${obj.id}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ set: { [map.status]: "open" }, version: obj.version }),
})).json();
out(stale);
console.log(`
  Refused, not merged. Merging looks helpful and is how one client's edit
  silently reverts another's, with the writer told it landed.`);

show("Catch up", "Hand back the cursor from step 2 and ask what has moved. This is where a follower meets its own write coming back.", `GET /interchange?since=${env.cursor}`);
const delta = await get(`/interchange?since=${env.cursor}`);
out({ cursor: delta.cursor, changes: delta.changes, objects: delta.objects.map((o) => ({ id: o.id, version: o.version })) });
console.log(`
  One row, one object, and the consumer already holds version ${answer.object.version} from step 4 —
  so applying this changes nothing. That is the whole trick: the echo is made
  harmless rather than filtered out.

  Filtering would have been worse. Look at what arrived with it: \`finished_on\`,
  which the producer added on its own. A follower skipping "changes I caused"
  discards that — and in a real library it would also miss the next occurrence
  of a repeating task, which is a new object created by the same write.`);

console.log(`\n${"─".repeat(74)}
Five requests: one to ask what it is, one to read, two to write, one to catch up.
The consumer never learned what a Chore is, and never needed to.
${"─".repeat(74)}`);
server.close();
