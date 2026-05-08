# BYO-App Push-Pull Roundtrip Simulator

This simulator is a compact proof that a sanitized external community app can behave like a Post Fiat-native intelligence node. It models the push-pull loop where a BYO app exports an observation into Post Fiat, and Post Fiat either emits a network-generated question back, suppresses the request, blocks it, or escalates it.

The implementation is intentionally small and self-contained. It does not call Post Fiat services, does not read files, does not write files, does not install dependencies, and does not reimplement the existing payload linter. The only output is deterministic JSON printed to stdout.

## Run

```bash
python3 byo_app_roundtrip_simulator.py
```

## What the Code Models

Each fixture represents one outbound observation from a sanitized external app. The simulator accepts the observation into an in-memory contract and then decides the inbound question state.

The contract fields are deliberately minimal:

- `contract_version`: the handoff contract version the observation claims to use.
- `idempotency_key`: the unique export key used to prevent duplicate question emission.
- `observed_at`: the timestamp used for stale-input decisions.
- `source`: sanitized source metadata with `app_id`, `source_kind`, and `export_id`.
- `confidence`: a deterministic classifier confidence value.
- `privacy_flags`: sanitized privacy gate markers such as `direct_identifier`.
- `sanitized_observation`: human-readable, non-sensitive fixture text.

## Decision Order

`transition_roundtrip` returns exactly one state for each input fixture. The order is intentional:

1. Reject a contract version mismatch as `missing_source_metadata` with reason `contract_version_mismatch`.
2. Reject a missing idempotency key or missing source fields as `missing_source_metadata`.
3. Suppress an already-emitted idempotency key as `duplicate_suppressed`.
4. Block any privacy-flagged observation as `privacy_blocked`.
5. Reject observations older than the TTL as `stale_input`.
6. Escalate observations below the confidence floor as `low_confidence_escalated`.
7. Emit one inbound question as `question_emitted`.

Privacy is checked before staleness. If an observation is both stale and privacy-flagged, Post Fiat should immediately classify it under the privacy gate instead of treating it merely as old data.

## Idempotency Behavior

The simulator stores emitted questions in an in-memory `emitted_by_key` dictionary. When a clean observation emits a question, its idempotency key is recorded with the generated `question_id`.

If the same idempotency key appears again, the simulator does not emit another question. It returns `duplicate_suppressed` and includes the original `question_id` in the receipt, proving that accepted keys produce at most one inbound question.

## Fixtures

The embedded fixtures cover ten roundtrip cases:

| Case | Purpose | Expected inbound state |
| --- | --- | --- |
| `rt-001-clean-alpha` | Clean accepted observation | `question_emitted` |
| `rt-002-duplicate-alpha` | Duplicate of the first accepted key | `duplicate_suppressed` |
| `rt-003-clean-beta` | Second clean accepted observation | `question_emitted` |
| `rt-004-stale-input` | Observation older than the TTL | `stale_input` |
| `rt-005-missing-source-metadata` | Missing sanitized app identity | `missing_source_metadata` |
| `rt-006-low-confidence` | Confidence below the emission floor | `low_confidence_escalated` |
| `rt-007-privacy-blocked` | Privacy flag present | `privacy_blocked` |
| `rt-008-clean-gamma` | Third clean accepted observation | `question_emitted` |
| `rt-009-duplicate-gamma` | Duplicate of the third accepted key | `duplicate_suppressed` |
| `rt-010-stale-privacy-blocked` | Stale and privacy-flagged input | `privacy_blocked` |

## Output Shape

The script prints one stable JSON object with these top-level fields:

- `simulator_version`
- `contract_version`
- `total_roundtrips`
- `transition_counts`
- `duplicate_suppression_count`
- `stale_input_count`
- `privacy_block_count`
- `question_emission_count`
- `escalation_count`
- `transition_receipts`

`transition_receipts` is ordered by fixture sequence. Each receipt shows the original case, idempotency key, source app, outbound state, inbound state, optional question ID, and reason.

## Expected Counts

With the current fixtures, the deterministic counts are:

```json
{
  "total_roundtrips": 10,
  "question_emission_count": 3,
  "duplicate_suppression_count": 2,
  "stale_input_count": 1,
  "privacy_block_count": 2,
  "escalation_count": 1
}
```

The proof point is that Post Fiat can make a deterministic handoff decision without subjective reviewer interpretation: emit one question, suppress duplicates, reject stale inputs, block privacy-flagged content, escalate low-confidence input, and preserve an auditable receipt for every roundtrip.
