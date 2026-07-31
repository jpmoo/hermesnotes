import postgres from "postgres";
import { HttpError } from "../lib/errors.js";

export interface AdminConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string; // maintenance db, usually "postgres"
  ssl?: boolean;
}

export interface AppDb {
  host: string;
  port: number;
  dbName: string; // validated identifier
  user: string; // validated identifier
  password: string;
}

// dbName / user are validated as bare identifiers upstream; quote defensively anyway.
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function connect(conn: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}) {
  return postgres({
    host: conn.host,
    port: conn.port,
    username: conn.user,
    password: conn.password,
    database: conn.database,
    ssl: conn.ssl ? "require" : undefined,
    max: 1,
    connect_timeout: 10,
  });
}

/** Postgres error shapes we can say something useful about. */
interface PgLikeError {
  code?: string;
  message?: string;
  severity?: string;
}
const asPg = (err: unknown): PgLikeError => (err && typeof err === "object" ? (err as PgLikeError) : {});
const raw = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Say what actually went wrong, in the terms the person setting this up can act
 * on. Postgres reports these precisely (SQLSTATE) and the driver reports the
 * connection ones as syscall codes; passing either through verbatim leaves
 * someone reading "28P01" with nothing to do about it.
 */
function describeConnection(err: unknown, conn: { host: string; port: number; database: string; user: string }): string {
  const { code } = asPg(err);
  const where = `${conn.host}:${conn.port}`;
  switch (code) {
    case "ECONNREFUSED":
      return `Nothing accepted a connection at ${where}. Is PostgreSQL running there, and listening on TCP? (A fresh install often listens only on a Unix socket — set listen_addresses in postgresql.conf.)`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `The host "${conn.host}" couldn't be resolved.`;
    case "ETIMEDOUT":
    case "CONNECT_TIMEOUT":
      return `Timed out reaching ${where} — usually a firewall, or PostgreSQL listening on a different address.`;
    case "28P01":
      return `PostgreSQL rejected the password for "${conn.user}".`;
    case "28000":
      return `PostgreSQL refused a connection for "${conn.user}" from this machine. Its pg_hba.conf needs a line allowing that user from here.`;
    case "3D000":
      return `The maintenance database "${conn.database}" doesn't exist on that server. "postgres" is the usual one.`;
    default:
      return raw(err);
  }
}

/**
 * Create the application role + database using a privileged admin connection,
 * then install extensions in the new database (pgvector isn't a trusted
 * extension, so the app role can't create it itself). Returns the app
 * connection string. Idempotent where possible.
 */
export async function provisionDatabase(admin: AdminConn, app: AppDb): Promise<string> {
  const adminSql = await connect(admin);
  try {
    const role = await adminSql`SELECT 1 FROM pg_roles WHERE rolname = ${app.user}`;
    if (role.length === 0) {
      await adminSql.unsafe(
        `CREATE ROLE ${quoteIdent(app.user)} WITH LOGIN PASSWORD ${quoteLiteral(app.password)}`,
      );
    } else {
      await adminSql.unsafe(
        `ALTER ROLE ${quoteIdent(app.user)} WITH LOGIN PASSWORD ${quoteLiteral(app.password)}`,
      );
    }

    const dbExists = await adminSql`SELECT 1 FROM pg_database WHERE datname = ${app.dbName}`;
    if (dbExists.length === 0) {
      // CREATE DATABASE cannot run inside a transaction block.
      await adminSql.unsafe(
        `CREATE DATABASE ${quoteIdent(app.dbName)} OWNER ${quoteIdent(app.user)}`,
      );
    }
  } catch (err) {
    const { code } = asPg(err);
    if (code === "42501" || code === "42P01") {
      throw new HttpError(
        502,
        `The admin login "${admin.user}" isn't allowed to create the role or database. It needs CREATEROLE and CREATEDB (a superuser has both). Postgres said: ${raw(err)}`,
      );
    }
    throw new HttpError(502, `Couldn't create the database: ${describeConnection(err, { ...admin, user: admin.user })}`);
  } finally {
    await adminSql.end({ timeout: 5 });
  }

  // Install extensions in the NEW database as admin (superuser-only for pgvector).
  const newDbAdmin = await connect({
    host: admin.host,
    port: admin.port,
    user: admin.user,
    password: admin.password,
    database: app.dbName,
    ssl: admin.ssl,
  });
  try {
    await newDbAdmin.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await newDbAdmin.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await newDbAdmin.unsafe(
      `GRANT ALL ON DATABASE ${quoteIdent(app.dbName)} TO ${quoteIdent(app.user)}`,
    );
  } catch (err) {
    const { code, message = "" } = asPg(err);
    // "not available" is Postgres saying the extension's files aren't on the
    // server at all — a missing package, not a permission. They need different
    // things done about them, and calling one the other sends people hunting
    // for a privilege problem that isn't there.
    const missing = code === "58P01" || /is not available/i.test(message);
    if (missing) {
      // Name the exact package: it's per major version, and guessing wrong is
      // the next thing that wastes their time.
      let major = "";
      try {
        const [row] = await newDbAdmin.unsafe(`SHOW server_version_num`);
        const num = Number((row as Record<string, unknown>)?.server_version_num ?? 0);
        if (num) major = String(Math.floor(num / 10000));
      } catch {
        /* best effort — the advice still stands without the number */
      }
      const pkg = major ? `postgresql-${major}-pgvector` : "postgresql-<version>-pgvector";
      throw new HttpError(
        502,
        [
          "PostgreSQL doesn't have the pgvector extension installed, so the database can't be created.",
          "Hermes keeps note embeddings in a vector column — it's required, not optional.",
          `Install it on the database server and try again: Debian/Ubuntu "sudo apt install ${pkg}", macOS "brew install pgvector", or run the pgvector/pgvector${major ? `:pg${major}` : ""} Docker image instead of plain postgres.`,
        ].join(" "),
      );
    }
    if (code === "42501") {
      throw new HttpError(
        502,
        `The admin login "${admin.user}" isn't allowed to install extensions in the new database — installing pgvector needs a superuser. Postgres said: ${raw(err)}`,
      );
    }
    throw new HttpError(502, `Couldn't prepare the new database: ${raw(err)}`);
  } finally {
    await newDbAdmin.end({ timeout: 5 });
  }

  const u = encodeURIComponent(app.user);
  const p = encodeURIComponent(app.password);
  const d = encodeURIComponent(app.dbName);
  const sslSuffix = admin.ssl ? "?sslmode=require" : "";
  return `postgres://${u}:${p}@${app.host}:${app.port}/${d}${sslSuffix}`;
}
