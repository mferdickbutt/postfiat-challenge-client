/**
 * challengeDb.js
 *
 * SQLite persistence for the challenge-response client.
 * Stores Instruction tx details, verification results, and Response tx hashes.
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, 'data');
const DB_PATH = join(DB_DIR, 'challenge.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS challenge_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      instruction_tx  TEXT    NOT NULL,
      cid             TEXT    NOT NULL,
      challenge_type  TEXT    NOT NULL,
      challenger      TEXT    NOT NULL,
      received_at     INTEGER NOT NULL,
      verified        INTEGER NOT NULL,
      proof_hash      TEXT,
      response_tx     TEXT,
      completed_at    INTEGER,
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_instruction_tx
      ON challenge_log(instruction_tx);
  `);

  return _db;
}

/**
 * Insert a new challenge record immediately when the Instruction is received.
 */
export function insertChallenge({
  instruction_tx,
  cid,
  challenge_type,
  challenger,
  verified,
  proof_hash = null,
  response_tx = null,
  error = null,
}) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO challenge_log
      (instruction_tx, cid, challenge_type, challenger, received_at, verified, proof_hash, response_tx, completed_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    instruction_tx,
    cid,
    challenge_type,
    challenger,
    now,
    verified ? 1 : 0,
    proof_hash,
    response_tx,
    response_tx ? now : null,
    error,
  );
}

/**
 * Update an existing record with the submitted Response transaction hash.
 */
export function updateResponseTx(instruction_tx, response_tx) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE challenge_log
    SET response_tx = ?, completed_at = ?
    WHERE instruction_tx = ?
  `).run(response_tx, now, instruction_tx);
}

/**
 * Return the N most recent challenge records, newest first.
 */
export function recentChallenges(limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM challenge_log ORDER BY received_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Check whether a nonce has already been seen (replay-attack prevention).
 * Inspects the cid column — callers embed the nonce in the CID key for dedup.
 */
export function nonceAlreadySeen(instruction_tx) {
  const db = getDb();
  return !!db.prepare(
    'SELECT 1 FROM challenge_log WHERE instruction_tx = ?'
  ).get(instruction_tx);
}
