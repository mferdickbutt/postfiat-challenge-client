/**
 * listener.js
 *
 * Subscribes to the postfiatd WebSocket and emits parsed Instruction objects
 * whenever a transaction with an instruction memo targets the validator.
 *
 * Accepts:
 *   - Payment where Destination === validatorAccount
 *   - AccountSet where Account === validatorAccount (self-triggered for testing)
 */

const MEMO_TYPE_INSTRUCTION = Buffer.from('instruction').toString('hex').toUpperCase();

function hexDecode(hex) {
  return Buffer.from(hex, 'hex').toString('utf8');
}

function parseInstructionMemo(memos) {
  if (!Array.isArray(memos)) return null;
  for (const { Memo } of memos) {
    if (!Memo?.MemoType) continue;
    const memoType = Memo.MemoType.toUpperCase();
    if (memoType !== MEMO_TYPE_INSTRUCTION) continue;
    if (!Memo.MemoData) continue;
    try {
      return JSON.parse(hexDecode(Memo.MemoData));
    } catch {
      console.warn('[listener] Failed to parse Instruction MemoData as JSON');
      return null;
    }
  }
  return null;
}

export async function startListener(client, validatorAccount, onInstruction) {
  await client.request({
    command: 'subscribe',
    accounts: [validatorAccount],
  });

  console.log('[listener] Subscribed to transactions for', validatorAccount);

  client.on('transaction', (event) => {
    const tx = event.transaction;
    if (!tx) return;

    // Accept Payment to validator OR AccountSet from validator (self-test)
    const isPaymentToUs = tx.TransactionType === 'Payment' && tx.Destination === validatorAccount;
    const isSelfTriggered = tx.TransactionType === 'AccountSet' && tx.Account === validatorAccount;
    
    if (!isPaymentToUs && !isSelfTriggered) return;

    const txHash = event.transaction.hash ?? tx.hash;
    const memoData = parseInstructionMemo(tx.Memos);
    if (!memoData) return;

    const { cid, nonce, expires_at } = memoData;

    if (!cid || typeof cid !== 'string') {
      console.warn('[listener] Instruction tx', txHash, 'missing cid - skipping');
      return;
    }

    if (expires_at && Math.floor(Date.now() / 1000) > expires_at) {
      console.warn('[listener] Instruction tx', txHash, 'expired - skipping');
      return;
    }

    const instruction = {
      txHash,
      cid,
      nonce: nonce ?? null,
      expires_at: expires_at ?? null,
      challenger: tx.Account,
    };

    console.log('[listener] Instruction received: tx=' + txHash + ' cid=' + cid + ' from=' + tx.Account);
    onInstruction(instruction).catch((err) => {
      console.error('[listener] Error processing instruction', txHash, ':', err.message);
    });
  });
}
