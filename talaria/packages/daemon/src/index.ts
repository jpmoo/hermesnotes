import { ConfigError, loadConfig, MIRROR_PATH, SOCKET_PATH } from "./config.js";
import { Hermes } from "./hermes.js";
import { Mirror } from "./mirror.js";
import { Queue } from "./queue.js";
import { buildServer, listen } from "./server.js";
import { Sync } from "./sync.js";

/**
 * The daemon.
 *
 * Comes up, serves the socket immediately, and syncs in the background. The
 * order matters: a daemon that waited for a successful sync before answering
 * would be unavailable exactly when the network is down, which is the one
 * circumstance it exists for.
 */

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

function backoff(consecutiveFailures: number, baseSeconds: number): number {
  // Gentle, capped, and jittered: a laptop that wakes on a hotel network
  // shouldn't hammer, and several of these across a fleet shouldn't sing in
  // chorus. (Jitter matters less for one machine than the cap does, but it
  // costs nothing.)
  const factor = Math.min(2 ** consecutiveFailures, 20);
  const seconds = Math.min(baseSeconds * factor, 15 * 60);
  return seconds * (0.85 + Math.random() * 0.3);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\ntalaria: ${err.message}\n`);
      process.exit(78); // EX_CONFIG — launchd will show it, and it means one thing
    }
    throw err;
  }

  const mirror = new Mirror(MIRROR_PATH);
  const hermes = new Hermes(config);
  const sync = new Sync(hermes, mirror, config.origin);
  const queue = new Queue(hermes, mirror);
  const app = buildServer({ config, mirror, hermes, sync, socketPath: SOCKET_PATH });

  await listen(app, SOCKET_PATH);
  log(`listening on ${SOCKET_PATH} — ${mirror.count()} blocks mirrored`);
  if (!sync.everSynced) log("no baseline yet: reads will be empty until Hermes can be reached");

  let stopping = false;
  let failures = 0;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    const result = await sync.catchUp();
    if (result.state === "ok") {
      failures = 0;
      if (result.changed) log(`sync: ${result.changed} block(s)${result.walked ? " (full walk)" : ""}`);
      const drained = await queue.drain();
      for (const r of drained) {
        if (r.outcome === "parked") log(`queue ${r.id}: parked — ${r.reason}`);
        else if (r.outcome === "applied") log(`queue ${r.id}: sent`);
      }
    } else if (result.state === "offline") {
      // Ordinary. Say it once per outage rather than every tick.
      if (failures === 0) log(`offline — serving from the mirror (${result.detail})`);
      failures += 1;
    } else {
      // Hermes answered and refused. That is worth repeating, because it will
      // not fix itself: a revoked key looks exactly like this.
      failures += 1;
      log(`sync error: ${result.detail}`);
    }
    if (!stopping) {
      const delay = failures ? backoff(failures, config.pollSeconds) : config.pollSeconds;
      timer = setTimeout(() => void tick(), delay * 1000);
    }
  };

  let timer: NodeJS.Timeout = setTimeout(() => void tick(), 0);

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — closing`);
    clearTimeout(timer);
    await app.close();
    mirror.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await main();
