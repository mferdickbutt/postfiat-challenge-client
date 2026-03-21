/**
 * responder.js
 *
 * Constructs, signs (ed25519), and submits a Response Payment transaction
 * to the XRPL testnet in reply to an Instruction challenge.
 *
 * Response transaction format:
 *   - TransactionType: "Payment"
 *   - Destination: challenger's XRPL account (sender of the Instruction)
 *   - Amount: "1" (1 drop — minimum non-zero)
 *   - Memos: [{ Memo: { MemoType: hex("response"), MemoData: hex(JSON) } }]
 *
 * MemoData JSON schema:
 * {
 *   "instruction_tx": "<tx hash>",
 *   "nonce": "<nonce from spec>",
 *   "type": "<check type>",
 *   "passed": true | false,
 *   "value": <number>,
 *   "measured_at": "<ISO 8601>",
 *   "proof": "<hex ed25519 signature of canonical proof JSON>"
 * }
 */

import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { Wallet } from 'xrpl';

const MEMO_TYPE_RESPONSE = Buffer.from('response').toString('hex').toUpperCase();

/**
 * Hex-encode a UTF-8 string for use in XRPL Memo fields.
 */
function hexEncode(str) {
  return Buffer.from(str, 'utf8').toString('hex').toUpperCase();
}

/**
 * Build the canonical proof object (deterministic JSON for signing).
 * Keys are sorted alphabetically to ensure consistent serialization.
 */
function buildProofPayload({ instruction_tx, nonce, type, passed, value, measured_at }) {
  return JSON.stringify({
    instruction_tx,
    measured_at,
    nonce: nonce ?? '',
    passed,
    type,
    value,
  });
}

/**
 * Sign the canonical proof payload with the validator's ed25519 signing key.
 * Uses Node.js crypto with the raw 32-byte ed25519 seed extracted from
 * the xrpl.Wallet private key (which is "ED" + 64 hex chars for ed25519 keys).
 *
 * @param {string} canonicalJson - deterministic JSON string
 * @param {Wallet} wallet - xrpl.Wallet instance
 * @returns {string} hex-encoded ed25519 signature
 */
function signProof(canonicalJson, wallet) {
  const msgBytes = Buffer.from(canonicalJson, 'utf8');

  // xrpl ed25519 private keys are stored as "ED" + 64 hex chars (32-byte seed).
  // Build a PKCS8 DER-encoded key so Node.js crypto can use it.
  const rawHex = wallet.privateKey.startsWith('ED')
    ? wallet.privateKey.slice(2)
    : wallet.privateKey;
  const seedBytes = Buffer.from(rawHex, 'hex');
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 header for ed25519
    seedBytes,
  ]);
  const privKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return cryptoSign(null, msgBytes, privKey).toString('hex');
}

/**
 * Construct and submit a Response Payment transaction.
 *
 * @param {import('xrpl').Client} client - connected xrpl Client
 * @param {Wallet} wallet - validator's xrpl.Wallet (for signing)
 * @param {object} instruction - parsed instruction: { txHash, nonce, challenger }
 * @param {object} verifyResult - from verifier.verify(): { type, passed, value, measured_at }
 * @returns {Promise<string>} submitted XRPL transaction hash
 */
export async function respond(client, wallet, instruction, verifyResult) {
  const { txHash, nonce, challenger } = instruction;
  const { type, passed, value, measured_at } = verifyResult;

  const canonicalJson = buildProofPayload({
    instruction_tx: txHash,
    nonce,
    type,
    passed,
    value,
    measured_at,
  });

  const proofHash = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  const proofSig = signProof(canonicalJson, wallet);

  const memoData = JSON.stringify({
    instruction_tx: txHash,
    nonce: nonce ?? '',
    type,
    passed,
    value,
    measured_at,
    proof: proofSig,
  });

  const tx = {
    TransactionType: 'Payment',
    Account: wallet.classicAddress,
    Destination: challenger,
    Amount: '1',
    Memos: [
      {
        Memo: {
          MemoType: MEMO_TYPE_RESPONSE,
          MemoData: hexEncode(memoData),
        },
      },
    ],
  };

  console.log(`[responder] Submitting Response tx to ${challenger} (passed=${passed})`);

  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const responseTxHash = result.result?.hash ?? signed.hash;

  if (result.result?.meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `Response tx failed: ${result.result?.meta?.TransactionResult} (hash=${responseTxHash})`
    );
  }

  console.log(`[responder] Response submitted: ${responseTxHash}`);
  return { responseTxHash, proofHash };
}
