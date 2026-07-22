/** Minimal fetch client for the Hermes API, bound to one bearer key. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`API ${status}`);
  }
}

export class Api {
  constructor(
    private base: string,
    private token: string,
  ) {}

  /** Stable per-user cache key (not the raw secret). */
  get cacheKey(): string {
    let h = 0;
    for (let i = 0; i < this.token.length; i++) h = (h * 31 + this.token.charCodeAt(i)) | 0;
    return String(h);
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text.slice(0, 500));
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.req("GET", path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.req("POST", path, body);
  }
  patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.req("PATCH", path, body);
  }
  put<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.req("PUT", path, body);
  }
  del<T = unknown>(path: string): Promise<T> {
    return this.req("DELETE", path);
  }
}
