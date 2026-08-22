import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export const SOCKET =
  process.env.TALARIA_SOCKET ?? join(homedir(), "Library", "Application Support", "Talaria", "talaria.sock");

export class DaemonDown extends Error {}

/**
 * Talk to the daemon over its socket.
 *
 * `node:http` dials a Unix socket directly, so this needs nothing installed —
 * which matters for a command meant to answer instantly and to keep working
 * when nothing else does.
 */
export function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        socketPath: SOCKET,
        path,
        method,
        headers: payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          let parsed: unknown = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              reject(new Error(`daemon sent something that isn't JSON: ${text.slice(0, 120)}`));
              return;
            }
          }
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            reject(new Error((parsed as { error?: string } | null)?.error ?? `HTTP ${status}`));
            return;
          }
          resolve(parsed as T);
        });
      },
    );
    req.on("error", (err) => {
      reject(
        new DaemonDown(
          `Can't reach the Talaria daemon at ${SOCKET}.\n` +
            `  Start it with:  pnpm --filter @talaria/daemon start\n` +
            `  (${err.message})`,
        ),
      );
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
