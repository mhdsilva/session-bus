import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, UnitOfWork } from "@session-bus/domain";
import BetterSqlite3 from "better-sqlite3";
import {
  artifactValues,
  canonicalJson,
  decodeArtifact,
  decodeEvent,
  decodeJson,
  decodeMembership,
  decodeRoom,
  decodeSession,
  decodeTask,
  eventValues,
  membershipValues,
  roomValues,
  sessionValues,
  taskValues,
} from "./codec.js";

const MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "migrations/001_initial.sql"),
  "utf8",
);
const VERSION = 1;

export interface SqliteOptions {
  filename: string;
}

/** SQLite adapter. Every operation is serialized because a single connection
 * is deliberately shared by all repository methods and async transactions. */
export class SqliteDatabase implements Database, AsyncDisposable {
  private readonly raw: BetterSqlite3.Database;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor({ filename }: SqliteOptions) {
    this.raw = new BetterSqlite3(filename, { timeout: 5000 });
    this.raw.pragma("foreign_keys = ON");
    this.raw.pragma("busy_timeout = 5000");
    if (filename !== ":memory:") this.raw.pragma("journal_mode = WAL");
    this.migrateSync();
  }

  async migrate(): Promise<void> {
    await this.exclusive(() => this.migrateSync());
  }

  async read<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return this.exclusive(async () => work(this.unitOfWork()));
  }

  async write<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.raw.exec("BEGIN IMMEDIATE");
      try {
        const result = await work(this.unitOfWork());
        this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.raw.inTransaction) this.raw.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.exclusive(() => {
      this.raw.close();
      this.closed = true;
    });
  }

  private async exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      if (this.closed) throw new Error("SQLite database is closed");
      return await fn();
    } finally {
      release();
    }
  }

  private migrateSync(): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      this.raw.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      const applied = this.raw
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(VERSION);
      if (!applied) {
        this.raw.exec(MIGRATION);
        this.raw
          .prepare(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
          )
          .run(VERSION, new Date().toISOString());
      }
      this.raw.exec("COMMIT");
    } catch (error) {
      if (this.raw.inTransaction) this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  private unitOfWork(): UnitOfWork {
    const db = this.raw;
    const one = (sql: string, ...args: unknown[]) =>
      db.prepare(sql).get(...args);
    const many = (sql: string, ...args: unknown[]) =>
      db.prepare(sql).all(...args);
    const run = (sql: string, ...args: unknown[]) =>
      db.prepare(sql).run(...args);
    const json = (text: string, label: string) =>
      decodeJson(text, label, (value) => value);
    return {
      sessions: {
        insert: async (s) => {
          run(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ...sessionValues(s),
          );
        },
        findById: async (id) => {
          const r = one("SELECT * FROM sessions WHERE id = ?", id);
          return r ? decodeSession(r) : null;
        },
        findByTokenHash: async (hash) => {
          const r = one("SELECT * FROM sessions WHERE token_hash = ?", hash);
          return r ? decodeSession(r) : null;
        },
        update: async (s) => {
          run(
            "UPDATE sessions SET name=?,harness_name=?,harness_version=?,project_root=?,capabilities_json=?,current_focus=?,metadata_json=?,status=?,last_seen_at=?,token_hash=? WHERE id=?",
            ...sessionValues(s).slice(1),
            s.id,
          );
        },
        listAll: async () =>
          many("SELECT * FROM sessions ORDER BY id").map(decodeSession),
      },
      rooms: {
        insert: async (r) => {
          run("INSERT INTO rooms VALUES (?,?,?,?,?,?,?)", ...roomValues(r));
        },
        findById: async (id) => {
          const r = one("SELECT * FROM rooms WHERE id = ?", id);
          return r ? decodeRoom(r) : null;
        },
        update: async (r) => {
          run(
            "UPDATE rooms SET title=?,objective=?,status=?,created_by=?,created_at=?,context_summary=? WHERE id=?",
            ...roomValues(r).slice(1),
            r.id,
          );
        },
        saveMembership: async (m) => {
          run(
            "INSERT INTO memberships VALUES (?,?,?,?,?,?) ON CONFLICT(room_id,session_id) DO UPDATE SET state=excluded.state,role=excluded.role,joined_at=excluded.joined_at,last_read_sequence=excluded.last_read_sequence",
            ...membershipValues(m),
          );
        },
        findMembership: async (roomId, sessionId) => {
          const r = one(
            "SELECT * FROM memberships WHERE room_id=? AND session_id=?",
            roomId,
            sessionId,
          );
          return r ? decodeMembership(r) : null;
        },
        listMemberships: async (roomId) =>
          many(
            "SELECT * FROM memberships WHERE room_id=? ORDER BY joined_at, session_id",
            roomId,
          ).map(decodeMembership),
      },
      events: {
        insert: async (e) => {
          run(
            "INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)",
            ...eventValues(e),
          );
        },
        nextSequence: async (roomId) =>
          Number(
            (
              one(
                "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM events WHERE room_id=?",
                roomId,
              ) as { next: number }
            ).next,
          ),
        listByRoom: async (roomId) =>
          many(
            "SELECT * FROM events WHERE room_id=? ORDER BY sequence ASC",
            roomId,
          ).map(decodeEvent),
        listAfter: async (roomId, afterSequence, limit) =>
          (limit === undefined
            ? many(
                "SELECT * FROM events WHERE room_id=? AND sequence>? ORDER BY sequence ASC",
                roomId,
                afterSequence,
              )
            : many(
                "SELECT * FROM events WHERE room_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?",
                roomId,
                afterSequence,
                limit,
              )
          ).map(decodeEvent),
      },
      tasks: {
        insert: async (t) => {
          run("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)", ...taskValues(t));
        },
        findById: async (id) => {
          const r = one("SELECT * FROM tasks WHERE id=?", id);
          return r ? decodeTask(r) : null;
        },
        update: async (t) => {
          run(
            "UPDATE tasks SET room_id=?,title=?,description=?,status=?,owner_session_id=?,result_summary=?,created_at=?,updated_at=? WHERE id=?",
            ...taskValues(t).slice(1),
            t.id,
          );
        },
        listByRoom: async (roomId) =>
          many(
            "SELECT * FROM tasks WHERE room_id=? ORDER BY created_at,id",
            roomId,
          ).map(decodeTask),
      },
      artifacts: {
        insert: async (a) => {
          run(
            "INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?)",
            ...artifactValues(a),
          );
        },
        listByRoom: async (roomId) =>
          many(
            "SELECT * FROM artifacts WHERE room_id=? ORDER BY created_at,id",
            roomId,
          ).map(decodeArtifact),
      },
      idempotency: {
        find: async (key) => {
          const r = one(
            "SELECT value_json FROM idempotency_keys WHERE key=?",
            key,
          ) as { value_json: string } | undefined;
          return r ? json(r.value_json, "idempotency value") : null;
        },
        save: async (key, value) => {
          run(
            "INSERT INTO idempotency_keys(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
            key,
            canonicalJson(value),
          );
        },
      },
    };
  }
}

export function openSqliteDatabase(options: SqliteOptions): SqliteDatabase {
  return new SqliteDatabase(options);
}
