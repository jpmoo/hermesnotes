import { toCanonical, kindOf, type HermesTypeRow, type HermesBlockRow } from "./src/index.js";

const taskSchema = {
  fields: [
    { key: "title", type: "text", order: 0, includeEmbed: true },
    { key: "description", type: "longtext", order: 1, includeEmbed: true },
    { key: "schedule", type: "datespan", order: 2, includeEmbed: false, startLabel: "Available", endLabel: "Due" },
    { key: "recurrence", type: "recurrence", order: 4, includeEmbed: false },
    { key: "project", type: "reference", order: 5, includeEmbed: false },
    { key: "status", type: "status", order: 6, includeEmbed: false,
      options: ["not_done", "done"], optionLabels: { not_done: "Not done" } },
  ],
  status_field: "status",
  complete_values: ["done"],
  default_value: "not_done",
} as never;

const personSchema = {
  fields: [
    { key: "title", type: "text", order: 0, includeEmbed: true },
    { key: "role", type: "text", order: 1, includeEmbed: true },
    { key: "organization", type: "reference", order: 3, includeEmbed: false },
  ],
} as never;

const types: HermesTypeRow[] = [
  { id: "t-task", name: "Task", propertySchema: taskSchema, isText: false, builtin: true },
  { id: "t-todo", name: "Todo", propertySchema: taskSchema, isText: false, builtin: false },
  { id: "t-person", name: "Contact", propertySchema: personSchema, isText: false, builtin: false },
  { id: "t-text", name: "text", propertySchema: null, isText: true, builtin: true },
];

const base = { collectionKind: null, version: 3, archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-20T00:00:00Z", tags: [] as string[] };

const rows: [string, HermesBlockRow, string][] = [
  ["seeded Task", { ...base, id: "b1", blockTypeId: "t-task", content: null, tags: ["work"],
    properties: { title: "Write up |048dd1db-1111-4111-8111-111111111111 for [Board](block:048dd1db-2222-4222-8222-222222222222)",
      description: "some notes", status: "done", done_at: "2026-08-19T10:00:00Z",
      schedule: { start: "2026-08-22", end: "2026-08-25T14:30" },
      recurrence: { frequency: "weekly", interval: 1, weekdays: [3], end: { type: "after", count: 5 }, completeFrom: "completed", n: 3 },
      project: "048dd1db-3333-4333-8333-333333333333" } }, "t-task"],
  ["renamed type (not builtin)", { ...base, id: "b2", blockTypeId: "t-todo", content: null,
    properties: { title: "Renamed but still a task", status: "not_done" } }, "t-todo"],
  ["person-shaped custom type", { ...base, id: "b3", blockTypeId: "t-person", content: null,
    properties: { title: "Adish", role: "Director", organization: "048dd1db-4444-4444-8444-444444444444" } }, "t-person"],
  ["daily note", { ...base, id: "b4", blockTypeId: "t-text", content: "# Thursday\n\n- [ ] call the roofer",
    properties: { today_note: "2026-08-22" } }, "t-text"],
  ["plain text block", { ...base, id: "b5", blockTypeId: "t-text", content: "## Meeting notes\nlots of detail", properties: {} }, "t-text"],
];

for (const [label, row, typeId] of rows) {
  const c = toCanonical(row, types.find((t) => t.id === typeId), { appOrigin: "https://app.example/hermesnotes" });
  console.log(`\n── ${label}`);
  console.log(JSON.stringify({
    kind: c.kind, title: c.title, done: c.completion?.done, label: c.completion?.label,
    schedule: c.schedule && { start: c.schedule.start, end: c.schedule.end, endLabel: c.schedule.endLabel },
    recurrence: c.recurrence && { seriesId: c.recurrence.seriesId, anchor: c.recurrence.anchor,
      occurrence: c.recurrence.occurrence, rrule: c.recurrence.expressibleAsRRULE },
    links: c.links, isDailyNote: c.isDailyNote, noteDate: c.noteDate, url: c.url,
  }, null, 1));
}
console.log("\n── kind fallbacks");
// The real case this got wrong: Hermes' seeding migrations skip any user who
// already made a type of that name, so a hand-made Project is user data with
// builtin=false and a shape that says nothing in particular.
const userProject = { fields: [
  { key: "title", type: "text", order: 0, includeEmbed: true },
  { key: "description", type: "longtext", order: 1, includeEmbed: true },
  { key: "phase", type: "select", order: 2, includeEmbed: false, options: ["active", "done"] },
] } as never;
console.log("user-made Project ->", kindOf("Project", userProject, { builtin: false }));
// ...but structure still outranks the name where it is decisive.
const projectShapedTask = { fields: [
  { key: "title", type: "text", order: 0, includeEmbed: true },
  { key: "status", type: "status", order: 1, includeEmbed: false, options: ["open", "shipped"] },
], status_field: "status", complete_values: ["shipped"] } as never;
console.log("a 'Project' that completes ->", kindOf("Project", projectShapedTask, { builtin: false }));
// A project with dates must not read as an event.
const datedProject = { fields: [
  { key: "title", type: "text", order: 0, includeEmbed: true },
  { key: "run", type: "datespan", order: 1, includeEmbed: false },
] } as never;
console.log("a Project with a datespan ->", kindOf("Project", datedProject, { builtin: false }));
console.log("collection      →", kindOf("list", null, { collectionKind: "list" }));
console.log("unknown shape   →", kindOf("Bookmark", { fields: [{ key: "title", type: "text", order: 0, includeEmbed: true }] } as never, {}));
console.log("event-shaped    →", kindOf("Gig", { fields: [{ key: "when", type: "datespan", order: 0, includeEmbed: false }] } as never, {}));
