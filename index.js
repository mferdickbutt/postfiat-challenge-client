/**
 * index.js
 *
 * Validator challenge-response client entry point.
 */

import https from "https";
import { Client, Wallet } from "xrpl";
import { startListener } from "./listener.js";
import { verify } from "./verifier.js";
import { respond } from "./responder.js";
import { insertChallenge, nonceAlreadySeen } from "./challengeDb.js";

const VALIDATOR_ACCOUNT = process.env.VALIDATOR_ACCOUNT;
const VALIDATOR_SECRET_KEY = process.env.VALIDATOR_SECRET_KEY;
const XRPL_WS_URL = process.env.XRPL_WS_URL ?? "wss://localhost:6005";

if (!VALIDATOR_ACCOUNT || !VALIDATOR_SECRET_KEY) {
  console.error("[challenge-client] ERROR: VALIDATOR_ACCOUNT and VALIDATOR_SECRET_KEY required");
  process.exit(1);
}

async function main() {
  const wallet = Wallet.fromSeed(VALIDATOR_SECRET_KEY);
  console.log("[challenge-client] Wallet address:", wallet.classicAddress);

  const agent = new https.Agent({ rejectUnauthorized: false });
  const client = new Client(XRPL_WS_URL, { connectionTimeout: 10000, agent });

  client.on("error", (err) => console.error("[challenge-client] XRPL error:", err.message));
  client.on("disconnected", (code) => {
    console.warn("[challenge-client] Disconnected (" + code + ") - reconnecting...");
    setTimeout(() => client.connect().catch(console.error), 5000);
  });

  console.log("[challenge-client] Connecting to " + XRPL_WS_URL + "...");
  await client.connect();
  console.log("[challenge-client] Connected.");

  await startListener(client, VALIDATOR_ACCOUNT, async (instruction) => {
    const { txHash, cid, nonce, challenger } = instruction;

    if (nonceAlreadySeen(txHash)) {
      console.warn("[challenge-client] Duplicate instruction " + txHash);
      return;
    }

    let verifyResult, error = null, responseTxHash = null, proofHash = null;

    try {
      verifyResult = await verify(cid, VALIDATOR_ACCOUNT);
    } catch (err) {
      error = err.message;
      console.error("[challenge-client] Verify failed:", err.message);
      insertChallenge({ instruction_tx: txHash, cid, challenge_type: "unknown", challenger, verified: false, error });
      return;
    }

    try {
      ({ responseTxHash, proofHash } = await respond(client, wallet, instruction, verifyResult));
    } catch (err) {
      error = err.message;
      console.error("[challenge-client] Response failed:", err.message);
    }

    insertChallenge({
      instruction_tx: txHash, cid, challenge_type: verifyResult.type, challenger,
      verified: verifyResult.passed, proof_hash: proofHash, response_tx: responseTxHash, error
    });

    if (responseTxHash) {
      console.log("[challenge-client] Challenge complete: instruction=" + txHash + " response=" + responseTxHash);
    }
  });

  console.log("[challenge-client] Listening for Instruction transactions...");

  process.on("SIGINT", async () => {
    console.log("\n[challenge-client] Shutting down...");
    await client.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[challenge-client] Fatal:", err);
  process.exit(1);
});
