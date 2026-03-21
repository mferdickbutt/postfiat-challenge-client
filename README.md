# PostFiat Challenge-Response Client

A validator challenge-response client for the PostFiat network. Listens for Instruction transactions, verifies them locally, and submits Response transactions.

## Features

- Real-time listening for Instruction transactions
- Local challenge verification
- Automatic Response transaction submission with cryptographic proof
- SQLite-backed deduplication (prevents replay attacks)
- Auto-reconnect on XRPL connection drops

## Requirements

- Node.js >= 20.0.0
- Access to an XRPL node

## Installation

```bash
npm install
```

## Configuration

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `VALIDATOR_ACCOUNT` | Validator XRPL account address | Yes |
| `VALIDATOR_SECRET_KEY` | Ed25519 secret key (seed) | Yes |
| `XRPL_WS_URL` | WebSocket URL for XRPL node | No (default: wss://localhost:6005) |

## Usage

```bash
export VALIDATOR_ACCOUNT=rXXX
export VALIDATOR_SECRET_KEY=sEdXXX
npm start
```

## Architecture

```
XRPL Ledger ──▶ listener.js ──▶ verifier.js ──▶ responder.js ──▶ Response TX
                                      │
                                      ▼
                               challengeDb.js (SQLite)
```

## License

MIT
