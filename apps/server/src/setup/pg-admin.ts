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
    throw new HttpError(
      502,
      `database provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
    throw new HttpError(
      502,
      `extension setup failed (the admin role must be a superuser to install pgvector): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    await newDbAdmin.end({ timeout: 5 });
  }

  const u = encodeURIComponent(app.user);
  const p = encodeURIComponent(app.password);
  const d = encodeURIComponent(app.dbName);
  const sslSuffix = admin.ssl ? "?sslmode=require" : "";
  return `postgres://${u}:${p}@${app.host}:${app.port}/${d}${sslSuffix}`;
}
