// dbManager.ts
import Database from "better-sqlite3";
import { dirname } from "path";
import { existsSync, mkdirSync } from "fs";

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

type Entry = {
  db: Database.Database;
  refCount: number;
  lastUsedAt: number;
};

// 可按需调整/做成环境变量
const DB_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

const dbCache = new Map<string, Entry>();
const keyLocks = new Map<string, Promise<void>>();

// 记录某个 dbPath 是否已经跑过 initializer（仅对“首次创建”生效）
const initialized = new Set<string>();

function withKeyLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = keyLocks.get(key) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  keyLocks.set(key, prev.then(() => next));

  return prev
    .then(() => fn())
    .finally(() => {
      release();
      if (keyLocks.get(key) === next) keyLocks.delete(key);
    });
}

export type DbInitializer = (db: Database.Database, dbPath: string) => void;

export async function acquireDb(
  dbPath: string,
  options?: {
    initializer?: DbInitializer; // 仅首次创建该 dbPath 时执行
    pragmas?: string[];          // e.g. ["journal_mode = WAL"]
  }
): Promise<Database.Database> {
  return withKeyLock(dbPath, () => {
    let entry = dbCache.get(dbPath);

    if (!entry) {
      ensureDir(dirname(dbPath));
      const db = new Database(dbPath);

      // 默认不强制任何 pragma；需要的话由调用方传入
      for (const p of options?.pragmas ?? []) db.pragma(p);

      entry = { db, refCount: 0, lastUsedAt: Date.now() };
      dbCache.set(dbPath, entry);
    }

    // 只在首次创建后、第一次 acquire 时跑 initializer，并且在 lock 内保证并发安全
    if (!initialized.has(dbPath) && options?.initializer) {
      options.initializer(entry.db, dbPath);
      initialized.add(dbPath);
    }

    entry.refCount += 1;
    return entry.db;
  });
}

export async function releaseDb(dbPath: string): Promise<void> {
  return withKeyLock(dbPath, () => {
    const entry = dbCache.get(dbPath);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAt = Date.now();
  });
}

async function sweepExpired(): Promise<void> {
  const now = Date.now();

  const tasks: Promise<void>[] = [];
  for (const [dbPath] of dbCache) {
    tasks.push(
      withKeyLock(dbPath, () => {
        const entry = dbCache.get(dbPath);
        if (!entry) return;

        const idleMs = now - entry.lastUsedAt;
        if (entry.refCount === 0 && idleMs > DB_TTL_MS) {
          try {
            entry.db.close();
          } finally {
            dbCache.delete(dbPath);
            initialized.delete(dbPath); // 下次再创建时允许重新 initializer
          }
        }
      })
    );
  }

  await Promise.all(tasks);
}

const sweepTimer = setInterval(() => void sweepExpired(), SWEEP_INTERVAL_MS);
(sweepTimer as any).unref?.();
