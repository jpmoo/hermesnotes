// Subpath-aware API base: import.meta.env.BASE_URL is the Vite `base` (e.g.
// "/hermesnotes/"), so this resolves to "/hermesnotes/api". Caddy strips the
// prefix before the server, which serves the API under "/api".
const BASE = `${import.meta.env.BASE_URL}api`;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, (data && (data.error as string)) || res.statusText);
  }
  return data as T;
}

/** Absolute API base (subpath-aware). Use for links/downloads and file uploads. */
export const apiBase = BASE;

async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "POST", credentials: "include", body: form });
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
