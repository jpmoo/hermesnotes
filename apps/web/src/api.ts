// Subpath-aware API base: import.meta.env.BASE_URL is the Vite `base` (e.g.
// "/hermesnotes/"), so this resolves to "/hermesnotes/api". Caddy strips the
// prefix before the server, which serves the API under "/api".
const BASE = `${import.meta.env.BASE_URL}api`;

/** A stable id for this browser tab. Sent on every request so the live-sync
 * stream can tell a tab which change events it caused (and skip its own). */
export const CLIENT_ID = crypto.randomUUID();

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Everything that can go wrong before a reply arrives, said plainly. A fetch
 * that rejects never reached the server; a body that isn't JSON came from
 * something in between (a proxy's error page). Both used to surface as a raw
 * TypeError or SyntaxError, which callers reported as a generic failure.
 */
export const describeRequestFailure = (err: unknown): ApiError =>
  err instanceof ApiError
    ? err
    : new ApiError(
        0,
        "Couldn't reach the server — it may not be running, or the address may be wrong.",
      );

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: "include",
      headers: {
        "x-client-id": CLIENT_ID,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw describeRequestFailure(null);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(
      res.status,
      res.ok
        ? "The server's reply wasn't the expected format."
        : `The server answered ${res.status} with ${text.trim().slice(0, 200) || "an empty reply"}.`,
    );
  }
  if (!res.ok) throw new ApiError(res.status, errorText(data) || res.statusText);
  return data as T;
}

/** The message out of an error body, including which field a rejection was about. */
function errorText(data: unknown): string {
  const d = (data ?? {}) as { error?: unknown; issues?: unknown };
  const base = typeof d.error === "string" ? d.error : "";
  if (base !== "validation" || !Array.isArray(d.issues)) return base;
  const parts = (d.issues as Array<{ path?: unknown[]; message?: string }>)
    .map((i) => `${(i.path ?? []).join(".") || "value"}: ${i.message ?? "invalid"}`)
    .slice(0, 4);
  return parts.length ? `Some values weren't accepted — ${parts.join("; ")}` : base;
}

/** Absolute API base (subpath-aware). Use for links/downloads and file uploads. */
export const apiBase = BASE;

async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "x-client-id": CLIENT_ID },
    body: form,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, (data && (data.error as string)) || res.statusText);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b ?? {}),
  del: <T>(p: string) => request<T>("DELETE", p),
  upload,
};

// ── Shared response shapes ──────────────────────────────────────
export interface User {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
}

export interface Block {
  id: string;
  blockTypeId: string;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  embeddedAt: string | null;
  embedPending: boolean;
  version: number;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  ollamaUrl: string | null;
  embedModel: string | null;
  embedDim: number | null;
  inferenceModel: string | null;
  defaultSimilarity: number;
  timezone: string | null;
  autoarchiveDoneDays: number | null;
  assistantMaxSteps: number | null;
  connected: boolean;
}

export interface OllamaModel {
  name: string;
  size?: number;
  parameterSize?: string;
  family?: string;
}

export interface BlockType {
  id: string;
  name: string;
  iconKey: string | null;
  iconColor: string | null;
  iconSource: string;
  showIcon: boolean;
  propertySchema: import("@hermes/shared").PropertySchema | null;
  schemaVersion: number;
  isText: boolean;
  builtin: boolean;
  blockCount?: number;
}

export interface BlockRef {
  id: string;
  label: string;
}

export interface Attachment {
  id: string;
  blockId: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface ConnRef {
  id: string;
  label: string;
  today?: string; // set when the connection is a daily note (its date)
  archived?: boolean; // target is archived (still resolvable, shown marked)
  iconKey: string | null;
  iconColor: string | null;
}

export interface BlockInfo {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  type: string;
  iconKey: string | null;
  iconColor: string | null;
  attachments: number;
  inCollections: ConnRef[];
  linksTo: ConnRef[];
  linkedFrom: ConnRef[];
  canvasConnections: (ConnRef & { edgeLabel?: string; canvasLabel: string })[];
  deletedLinks: { id: string }[]; // outbound links whose target no longer exists
  tags: string[];
}

export interface BlockSearchResult {
  id: string;
  blockTypeId: string | null;
  collectionKind: string | null;
  label: string;
}

export interface SearchHit {
  id: string;
  kind: "block" | "collection" | "today";
  date?: string; // for kind "today"
  blockTypeId: string | null;
  label: string;
  document: boolean;
  matrix: boolean;
  table: boolean;
  canvas: boolean;
  calendar: boolean;
  smart: boolean;
  semantic: boolean;
}

export interface Collection {
  id: string;
  collectionKind: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  iconKey: string | null;
  iconColor: string | null;
  collection: boolean;
  gen: number;
}
export interface GraphResult {
  root: string;
  nodes: GraphNode[];
  edges: { from: string; to: string }[];
  truncated: boolean;
}

export interface AgentStep {
  tool: string;
  args: unknown;
  result: string;
  ok: boolean;
}
export interface PendingCall {
  tool: string;
  args?: unknown;
}
export interface AgentReply {
  reply: string;
  steps: AgentStep[];
  pending?: PendingCall[];
}

export interface CalendarFeed {
  id: string;
  name: string;
  url: string;
  color: string;
  enabled: boolean;
  lastFetchedAt: string | null;
  lastError: string | null;
  /** What the calendar host said, and when — the diagnostics dialog's material. */
  lastStatus: number | null;
  lastDetail: string | null;
  lastErrorAt: string | null;
  /** When the stored copy the calendar renders from was last confirmed. */
  cachedAt: string | null;
  sort: number;
}

/** A read-only event pulled from a subscribed calendar feed. */
export interface FeedEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: string; // YYYY-MM-DD (all-day) or ISO datetime
  end: string | null;
  allDay: boolean;
  feedId: string;
  feedName: string;
  color: string;
}

export interface Member {
  membershipId: string;
  position: string;
  context: Record<string, unknown>;
  membershipVersion: number;
  id: string;
  blockTypeId: string | null;
  collectionKind: string | null;
  content: string | null;
  properties: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SetupStatus {
  configured: boolean;
  hasUsers: boolean;
  allowRegistration: boolean;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  createdAt: string;
  blockCount: number;
  protected: boolean;
}

export interface AccessKey {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedAccessKey {
  id: string;
  name: string;
  token: string; // shown once
}
