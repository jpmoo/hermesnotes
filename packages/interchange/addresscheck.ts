/**
 * An address a producer hands you is a promise.
 *
 * The format is careful that an id is opaque, precisely so that nobody
 * constructs a URL out of one — and then the producer constructed a wrong one.
 * Every address it published was a 404, because the origin was derived from a
 * request that had been through a proxy stripping a path prefix. Confidently
 * wrong is worse than absent: absent, a consumer knows it has nothing.
 *
 * So this asks the only question that matters about an address, which is
 * whether it opens. Given a live server it fetches one and reports the status;
 * given nothing it checks the shape, which is all that can be checked offline.
 *
 *   npx tsx addresscheck.ts                       # shapes only
 *   npx tsx addresscheck.ts <base> <token>        # and does one open?
 */
import { toInterchange } from "./src/map.js";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};

const block = (id: string) => ({
  id,
  blockTypeId: "t",
  collectionKind: null,
  content: null,
  properties: { title: "A thing" },
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
});

// ---- shape ----------------------------------------------------------------

const withBase = toInterchange({
  types: [{ id: "t", name: "Task", isText: false, propertySchema: null }],
  blocks: [block("o1")],
  memberships: [],
  origin: "https://app.example.com/hermesnotes",
}).envelope as { objects: { url?: string }[] };

check(
  "a subpath survives into the address",
  withBase.objects[0]?.url === "https://app.example.com/hermesnotes/block/o1",
  String(withBase.objects[0]?.url),
);

const trailing = toInterchange({
  types: [{ id: "t", name: "Task", isText: false, propertySchema: null }],
  blocks: [block("o1")],
  memberships: [],
  origin: "https://app.example.com/hermesnotes/",
}).envelope as { objects: { url?: string }[] };
check(
  "a trailing slash does not double up",
  !String(trailing.objects[0]?.url).includes("//block"),
  String(trailing.objects[0]?.url),
);

const none = toInterchange({
  types: [{ id: "t", name: "Task", isText: false, propertySchema: null }],
  blocks: [block("o1")],
  memberships: [],
}).envelope as { objects: { url?: string }[] };
check(
  "no origin means no address, rather than a guess",
  none.objects[0]?.url === undefined,
  String(none.objects[0]?.url),
);

// ---- does one open? -------------------------------------------------------

const [base, token] = process.argv.slice(2);
if (!base) {
  console.log("\n  (pass a base and token to check a live address opens)");
} else {
  const res = await fetch(`${base.replace(/\/$/, "")}/interchange`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const env = (await res.json()) as { objects?: { id: string; url?: string }[] };
  const objects = env.objects ?? [];
  const addressed = objects.filter((o) => o.url);
  check("the live export addresses its objects", addressed.length === objects.length,
    `${addressed.length}/${objects.length}`);

  const one = addressed[0];
  if (one?.url) {
    const hit = await fetch(one.url, { redirect: "follow" });
    check(`that address opens — ${one.url}`, hit.ok, `HTTP ${hit.status}`);
  }
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
