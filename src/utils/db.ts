/**
 * SQLite persistence for positions and performance snapshots.
 *
 * Uses better-sqlite3 (synchronous). The DB lives at ./data/meteor-flow.db and
 * the schema is created on first use.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Position } from "../types/index.js";

const DB_PATH = resolve(process.cwd(), "data", "meteor-flow.db");

let db: Database.Database | undefined;

/** Open (and memoize) the database, creating the schema if needed. */
export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_address        TEXT NOT NULL,
      pool_name           TEXT NOT NULL,
      position_pubkey     TEXT NOT NULL,
      strategy            TEXT NOT NULL,
      bin_lower           INTEGER NOT NULL,
      bin_upper           INTEGER NOT NULL,
      initial_deposit_usd REAL NOT NULL,
      current_value_usd   REAL NOT NULL,
      fees_collected_usd  REAL NOT NULL DEFAULT 0,
      net_profit          REAL NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'open',
      opened_at           INTEGER NOT NULL,
      closed_at           INTEGER
    );

    CREATE TABLE IF NOT EXISTS performance (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id        INTEGER,
      ts                 INTEGER NOT NULL,
      current_value_usd  REAL NOT NULL,
      fees_collected_usd REAL NOT NULL,
      net_profit         REAL NOT NULL,
      FOREIGN KEY (position_id) REFERENCES positions(id)
    );
  `);

  // Lightweight migrations for DBs created by earlier versions.
  const cols = (db.prepare("PRAGMA table_info(positions)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!cols.includes("position_pubkey")) {
    db.exec("ALTER TABLE positions ADD COLUMN position_pubkey TEXT NOT NULL DEFAULT ''");
  }

  return db;
}

/** Insert a new position and return its row id. */
export function insertPosition(p: Position): number {
  const stmt = getDb().prepare(`
    INSERT INTO positions (
      pool_address, pool_name, position_pubkey, strategy, bin_lower, bin_upper,
      initial_deposit_usd, current_value_usd, fees_collected_usd,
      net_profit, status, opened_at, closed_at
    ) VALUES (
      @poolAddress, @poolName, @positionPubkey, @strategy, @binLower, @binUpper,
      @initialDepositUsd, @currentValueUsd, @feesCollectedUsd,
      @netProfit, @status, @openedAt, @closedAt
    )
  `);
  const info = stmt.run({
    poolAddress: p.poolAddress,
    poolName: p.poolName,
    positionPubkey: p.positionPubkey,
    strategy: p.strategy,
    binLower: p.binLower,
    binUpper: p.binUpper,
    initialDepositUsd: p.initialDepositUsd,
    currentValueUsd: p.currentValueUsd,
    feesCollectedUsd: p.feesCollectedUsd,
    netProfit: p.netProfit,
    status: p.status,
    openedAt: p.openedAt,
    closedAt: p.closedAt ?? null,
  });
  return Number(info.lastInsertRowid);
}

/** Mark a position closed and record realized fees/PnL. */
export function markPositionClosed(
  id: number,
  fields: { feesCollectedUsd: number; currentValueUsd: number; netProfit: number },
): void {
  getDb()
    .prepare(`
      UPDATE positions
         SET status = 'closed', closed_at = @closedAt,
             fees_collected_usd = @feesCollectedUsd,
             current_value_usd = @currentValueUsd,
             net_profit = @netProfit
       WHERE id = @id
    `)
    .run({ id, closedAt: Date.now(), ...fields });
}

/** Count currently-open positions. */
export function countOpenPositions(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM positions WHERE status = 'open'")
    .get() as { n: number };
  return row.n;
}

/** Record a performance snapshot for an (optional) position. */
export function logPerformance(snapshot: {
  positionId?: number;
  currentValueUsd: number;
  feesCollectedUsd: number;
  netProfit: number;
}): void {
  getDb()
    .prepare(`
      INSERT INTO performance (position_id, ts, current_value_usd, fees_collected_usd, net_profit)
      VALUES (@positionId, @ts, @currentValueUsd, @feesCollectedUsd, @netProfit)
    `)
    .run({
      positionId: snapshot.positionId ?? null,
      ts: Date.now(),
      currentValueUsd: snapshot.currentValueUsd,
      feesCollectedUsd: snapshot.feesCollectedUsd,
      netProfit: snapshot.netProfit,
    });
}
