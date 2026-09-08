/**
 * Do the files actually travel?
 *
 * The fixtures measure the *format* — what an attachment value has to say about
 * itself, and what a consumer owes somebody when it is handed a name it cannot
 * resolve. They cannot measure the step before that, which is Hermes-specific
 * and was the real gap: Hermes keys attachments by block in a table of their
 * own, the exporter had no input for that table, and so nothing about an
 * attachment reached an export at all — not the bytes, and not the names.
 *
 * `features: ["attachments"]` was true only in the sense that some type
 * declared a field of that kind. This is the check that stops that being true
 * again.
 *
 *   npx tsx attachcheck.ts
 */
import { createHash } from "node:crypto";
import { fromInterchange } from "./src/import.js";
import { toInterchange } from "./src/map.js";
import { validateEnvelope } from "./src/validate.js";

let bad = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
  if (!ok) bad += 1;
};

const HELLO = Buffer.from("hello");
const HELLO_SHA = createHash("sha256").update(HELLO).digest("hex");

const noteType = {
  id: "t_note",
  name: "Note",
  isText: false,
  propertySchema: {
    fields: [
      { key: "title", type: "text", order: 0, includeEmbed: false },
      { key: "files", type: "attachments", order: 1, includeEmbed: false },
    ],
  },
};
const bareType = { id: "t_bare", name: "Bare", isText: false, propertySchema: null };

const block = (id: string, typeId: string) => ({
  id,
  blockTypeId: typeId,
  collectionKind: null,
  content: null,
  properties: { title: "A thing" },
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
});

const attachment = (blockId: string, filename: string, data: Uint8Array) => ({
  id: `a_${filename}`,
  blockId,
  filename,
  mime: "text/plain",
  size: data.byteLength,
  data,
});

type Envelope = {
  objects: { properties?: Record<string, unknown> }[];
  conformance?: { features?: string[] };
};
type Att = { kind?: string; filename?: string; mediaType?: string; sha256?: string; bytes?: string };

const run = (input: Parameters<typeof toInterchange>[0]) =>
  toInterchange(input) as unknown as { envelope: Envelope; findings: { code: string }[] };

// ---- a file rides along ----------------------------------------------------

const carried = run({
  types: [noteType as never],
  blocks: [block("o1", "t_note")],
  memberships: [],
  attachments: [attachment("o1", "hello.txt", HELLO)],
});
const files = carried.envelope.objects[0]?.properties?.files as Att[] | undefined;

check("a file reaches the export at all", Array.isArray(files) && files.length === 1, JSON.stringify(files)?.slice(0, 60));
check("under the field its type declares", Boolean(files?.[0]?.filename === "hello.txt"), String(files?.[0]?.filename));
check("with its media type", files?.[0]?.mediaType === "text/plain", String(files?.[0]?.mediaType));
check("hashed correctly", files?.[0]?.sha256 === HELLO_SHA, String(files?.[0]?.sha256));
check(
  "and the bytes are the bytes",
  Buffer.from(files?.[0]?.bytes ?? "", "base64").toString() === "hello",
  JSON.stringify(files?.[0]?.bytes),
);
check(
  "the manifest claims carrying them",
  Boolean(carried.envelope.conformance?.features?.includes("attachment-bytes")),
  (carried.envelope.conformance?.features ?? []).join(" "),
);
check("and the envelope validates", validateEnvelope(carried.envelope as never).valid,
  JSON.stringify(validateEnvelope(carried.envelope as never).errors));

// A file that arrived is not a loss, so nothing is reported about it.
check(
  "nothing is reported about a file that travelled",
  !fromInterchange(carried.envelope as never).findings.some((f) => f.code.startsWith("attachment.")),
  fromInterchange(carried.envelope as never).findings.map((f) => f.code).join(" "),
);

// ---- one too big to carry --------------------------------------------------

const big = new Uint8Array(64);
const capped = run({
  types: [noteType as never],
  blocks: [block("o1", "t_note")],
  memberships: [],
  attachments: [attachment("o1", "big.bin", big)],
  attachmentLimit: 16,
});
const over = (capped.envelope.objects[0]?.properties?.files as Att[])?.[0];
check("a file over the limit still names itself", over?.filename === "big.bin", String(over?.filename));
check("and still proves which file it is", typeof over?.sha256 === "string", String(over?.sha256));
check("but its bytes stay behind", over?.bytes === undefined, String(over?.bytes));
check(
  "the producer says so",
  capped.findings.some((f) => f.code === "attachment.too-large-to-carry"),
  capped.findings.map((f) => f.code).join(" "),
);
check(
  "and does not claim to carry files",
  !capped.envelope.conformance?.features?.includes("attachment-bytes"),
  (capped.envelope.conformance?.features ?? []).join(" "),
);

/*
 * The consumer's half of the same case, and the reason the cap is safe: a name
 * with a hash and no bytes is a *known-missing* file rather than an absent one,
 * so it arrives as a reported loss instead of silence.
 */
check(
  "and the consumer is told a file is missing",
  fromInterchange(capped.envelope as never).findings.some((f) => f.code === "attachment.bytes-not-carried"),
  fromInterchange(capped.envelope as never).findings.map((f) => f.code).join(" "),
);

// ---- nowhere to put it -----------------------------------------------------

const homeless = run({
  types: [bareType as never],
  blocks: [block("o2", "t_bare")],
  memberships: [],
  attachments: [attachment("o2", "orphan.txt", HELLO)],
});
check(
  "a block whose type declares no attachment field is reported",
  homeless.findings.some((f) => f.code === "attachment.no-field-to-hold-it"),
  homeless.findings.map((f) => f.code).join(" "),
);
check(
  "and nothing is invented to hold it",
  homeless.envelope.objects[0]?.properties?.files === undefined,
  JSON.stringify(homeless.envelope.objects[0]?.properties),
);

// ---- nobody asked ----------------------------------------------------------

const unasked = run({
  types: [noteType as never],
  blocks: [block("o1", "t_note")],
  memberships: [],
});
check(
  "an export built without files says so",
  unasked.findings.some((f) => f.code === "attachment.files-not-requested"),
  unasked.findings.map((f) => f.code).join(" "),
);

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
