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

export interface BlockInfo {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  type: string;
  attachments: number;
  inCollections: { id: string; label: string }[];
  linksTo: { id: string; label: string }[];
  linkedFrom: { id: string; label: string }[];
  tags: string[];
}

export interface BlockSearchResult {
  id: string;
  blockTypeId: string | null;
  label: string;
}

export interface Collection {
  id: string;
  collectionKind: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  version: number;
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
