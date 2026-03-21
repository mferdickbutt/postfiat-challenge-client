/**
 * verifier.js
 *
 * Fetches a verification spec from IPFS and runs the corresponding local check.
 *
 * SECURITY: The IPFS payload is treated as structured JSON data — NOT executable
 * code. Only allowlisted check types are supported. Unknown types are rejected.
 *
 * Supported check types:
 *   - "uptime"        — 24h uptime from SQLite health.db >= params.threshold
 *   - "peer_count"    — live peer_count from server_info RPC >= params.min
 *   - "ledger_height" — ledger_index from server_info RPC > 0 (node is synced)
 *
 * Spec JSON schema (from IPFS):
 * {
 *   "version": 1,
 *   "type": "uptime" | "peer_count" | "ledger_height",
 *   "params": { "threshold"?: number, "min"?: number },
 *   "nonce": "<string>",
 *   "expires_at": <unix epoch>
 * }
 */

import Database from 'better-sqlite3';
import { join } from 'node:path';

const ALLOWED_TYPES = new Set(['uptime', 'peer_count', 'ledger_height']);

const RPC_URL = process.env.POSTFIATD_RPC_URL ?? 'http://localhost:5005';
const MAPPER_DB_PATH =
  process.env.MAPPER_DB_PATH ??
  join(new URL('..', import.meta.url).pathname, 'validator-history-mapper', 'data', 'health.db');

const MIN_CHECKS = 10; // minimum data points required to compute uptime

// ---------------------------------------------------------------------------
// IPFS fetch — mirrors mapper.js fetchData() without importing it directly
// ---------------------------------------------------------------------------

async function fetchFromIpfs(cid) {
  const url = `https://ipfs.io/ipfs/${cid}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`IPFS gateway fetch failed [${res.status} ${res.statusText}]: ${url}`);
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// postfiatd JSON-RPC helper (non-admin)
// ---------------------------------------------------------------------------

async function rpc(method, params = [{}]) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.result?.status === 'error') throw new Error(`RPC ${method}: ${body.result.error}`);
  return body.result;
}

// ---------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------

function checkUptime(validatorId, threshold) {
  let db;
  try {
    db = new Database(MAPPER_DB_PATH, { readonly: true });
  } catch (err) {
    throw new Error(`Cannot open mapper health.db at ${MAPPER_DB_PATH}: ${err.message}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const since = now - 86400; // 24 hours

  const row = db.prepare(
    'SELECT COUNT(*) as total, SUM(is_up) as up_count FROM health_checks WHERE validator_id = ? AND timestamp >= ?'
  ).get(validatorId, since);

  db.close();

  if (!row || row.total < MIN_CHECKS) {
    throw new Error(`Insufficient uptime data: only ${row?.total ?? 0} checks in last 24h (need ${MIN_CHECKS})`);
  }

  const value = Math.round((row.up_count / row.total) * 1000) / 1000;
  const passed = value >= threshold;
  return { type: 'uptime', passed, value };
}

async function checkPeerCount(min) {
  const result = await rpc('server_info');
  const peers = result?.info?.peers ?? 0;
  return { type: 'peer_count', passed: peers >= min, value: peers };
}

async function checkLedgerHeight() {
  const result = await rpc('server_info');
  const ledgerIndex = result?.info?.validated_ledger?.seq ?? 0;
  const state = result?.info?.server_state ?? 'unknown';
  const synced = ['full', 'validating', 'proposing'].includes(state) && ledgerIndex > 0;
  return { type: 'ledger_height', passed: synced, value: ledgerIndex };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a verification spec from IPFS and run the local check.
 *
 * @param {string} cid - IPFS CID pointing to a JSON verification spec
 * @param {string} validatorId - validator ID used for uptime DB lookup
 * @returns {Promise<{ type: string, passed: boolean, value: number, measured_at: string }>}
 */
export async function verify(cid, validatorId) {
  console.log(`[verifier] Fetching spec from ipfs://${cid}`);
  const raw = await fetchFromIpfs(cid);

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    throw new Error(`Verification spec at ${cid} is not valid JSON`);
  }

  const { type, params = {} } = spec;

  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`Unknown verification type "${type}" — allowed: ${[...ALLOWED_TYPES].join(', ')}`);
  }

  console.log(`[verifier] Running ${type} check (params: ${JSON.stringify(params)})`);

  let result;
  if (type === 'uptime') {
    const threshold = typeof params.threshold === 'number' ? params.threshold : 0.95;
    result = checkUptime(validatorId, threshold);
  } else if (type === 'peer_count') {
    const min = typeof params.min === 'number' ? params.min : 5;
    result = await checkPeerCount(min);
  } else {
    result = await checkLedgerHeight();
  }

  const measured_at = new Date().toISOString();
  console.log(`[verifier] ${type} check: ${result.value} → ${result.passed ? 'passed' : 'failed'}`);

  return { ...result, measured_at };
}
