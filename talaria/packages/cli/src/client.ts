import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the daemon is listening.
 *
 * A second copy of the rule in `daemon/src/config.ts`, and deliberately so: the
 * CLI depends on `@talaria/canonical` and nothing else, and importing the
 * daemon's config to learn one string would drag fastify's dependency tree into
 * a command whose whole appeal is that it starts instantly.
 *
 * The copy is the cost, and it has already been paid once — this said
 * `~/Library` while the daemon had moved to XDG, so the first Linux run brought
 * the daemon up successfully and then reported it down. **If the rule in
 * `config.ts` changes, change it here.**
 */
export const SOCKET =
  process.env.TALARIA_SOCKET ??
  join(
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Talaria")
      : join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "talaria"),
    "talaria.sock",
  );

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
            (process.platform === "darwin"
              ? `  Start it with:  pnpm --filter @talaria/daemon start\n`
              : `  Start it with:  systemctl --user start talaria\n` +
                `  Why it stopped: journalctl --user -u talaria -n 30\n`) +
            `  (${err.message})`,
        ),
      );
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
