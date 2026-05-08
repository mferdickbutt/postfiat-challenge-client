#!/usr/bin/env python3
"""Deterministic BYO-app push-pull roundtrip simulator.

This intentionally avoids the existing payload linter. It models only the
handoff contract, lifecycle transitions, idempotency suppression, and the final
question decision for sanitized external community app observations.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple


SIMULATOR_VERSION = "byo-app-roundtrip-simulator/1.0.0"
CONTRACT_VERSION = "pf-byo-roundtrip-contract/2026-05-08"
REFERENCE_TIME = "2026-05-08T00:00:00Z"
STALE_AFTER_SECONDS = 24 * 60 * 60
LOW_CONFIDENCE_THRESHOLD = 0.50

TRANSITION_ORDER = [
    "question_emitted",
    "duplicate_suppressed",
    "stale_input",
    "missing_source_metadata",
    "privacy_blocked",
    "low_confidence_escalated",
]


FIXTURES = [
    {
        "case_id": "rt-001-clean-alpha",
        "contract_version": CONTRACT_VERSION,
        "idempotency_key": "app-alpha:export-0001",
        "observed_at": "2026-05-07T23:55:00Z",
        "source": {
            "app_id": "sanitized-forum-alpha",
            "source_kind": "external_community_app",
            "export_id": "export-0001",
        },
        "confidence": 0.92,
        "privacy_flags": [],
        "sanitized_observation": "Several members independently ask how contribution scoring is explained.",
    },
    {
        "case_id": "rt-002-duplicate-alpha",
        "contract_version": CONTRACT_VERSION,
        "idempotency_key": "app-alpha:export-0001",
        "observed_at": "2026-05-07T23:56:00Z",
        "source": {
            "app_id": "sanitized-forum-alpha",
            "source_kind": "external_community_app",
            "export_id": "export-0001-replay",
        },
        "confidence": 0.94,
        "privacy_flags": [],
        "sanitized_observation": "Replay of the same contribution scoring observation.",
    },
    {
        "case_id": "rt-003-clean-beta",
        "contract_version": CONTRACT_VERSION,
        "idempotency_key": "app-beta:export-0100",
        "observed_at": "2026-05-07T20:10:00Z",
        "source": {
            "app_id": "sanitized-discord-bridge",
            "source_kind": "external_community_app",
            "export_id": "export-0100",
        },
        "confidence": 0.81,
        "privacy_flags": [],
        "sanitized_observation": "A moderation cluster wants a canonical answer on validator onboarding readiness.",
    },
    {
        "case_id": "rt-004-stale-input",
        "contract_version": CONTRACT_VERSION,
        "idempotency_key": "app-gamma:export-0200",
        "observed_at": "2026-05-05T18:00:00Z",
        "source": {
            "app_id": "sanitized-townhall-notes",
            "source_kind": "external_community_app",
            "export_id": "export-0200",
        },
        "confidence": 0.88,
        "privacy_flags": [],
        "sanitized_observation": "Old governance notes mention uncertainty that has already aged out.",
    },
    {
        "case_id": "rt-005-missing-source-metadata",
        "contract_version": CONTRACT_VERSION,
        "idempotency_key": "app-delta:export-0300",
        "observed_at": "2026-05-07T22:00:00Z",
        "source": {
            "source_kind": "external_community_app",
            "export_id": "export-0300",
        },
        "confidence": 0.86,
        "privacy_flags": [],
        "sanitized_observation": "Observation cannot be traced to a sanitized app identity.",
    },
    {
        "case_id": "rt-006-low-confidence",
        "contract_version": CONTRACT_VERSION,
        "idempotency_key": "app-epsilon:export-0400",
        "observed_at": "2026-05-07T21:30:00Z",
        "source": {
            "app_id": "sanitized-signal-bridge",
            "source_kind": "external_community_app",
            "export_id": "export-0400",
        },
        "confidence": 0.37,
        "privacy_flags": [],
        "sanitized_observation": "The app reports a possible concern but its classifier is below the confidence floor.",
    },
    {
        "case_id": "rt-007-privacy-blocked",
        "contract_version": CONTRACT_VERSION,
        "idempotency_key": "app-zeta:export-0500",
        "observed_at": "2026-05-07T23:10:00Z",
        "source": {
            "app_id": "sanitized-forum-zeta",
            "source_kind": "external_community_app",
            "export_id": "export-0500",
        },
        "confidence": 0.90,
        "privacy_flags": ["direct_identifier"],
        "sanitized_observation": "A post still contains a direct identifier and must not produce a network question.",
    },
    {
        "case_id": "rt-008-clean-gamma",
        "contract_version": CONTRACT_VERSION,
        "idempotency_key": "app-theta:export-0600",
        "observed_at": "2026-05-07T19:45:00Z",
        "source": {
            "app_id": "sanitized-lens-theta",
            "source_kind": "external_community_app",
            "export_id": "export-0600",
        },
        "confidence": 0.74,
        "privacy_flags": [],
        "sanitized_observation": "Users repeatedly ask what evidence would resolve a peer defense challenge.",
    },
    {
        "case_id": "rt-009-duplicate-gamma",
        "contract_version": CONTRACT_VERSION,
        "idempotency_key": "app-theta:export-0600",
        "observed_at": "2026-05-07T19:46:00Z",
        "source": {
            "app_id": "sanitized-lens-theta",
            "source_kind": "external_community_app",
            "export_id": "export-0600-replay",
        },
        "confidence": 0.76,
        "privacy_flags": [],
        "sanitized_observation": "Replay of the same peer defense challenge observation.",
    },
]


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def required_source_metadata_present(source: Dict[str, str]) -> bool:
    return all(source.get(field) for field in ("app_id", "source_kind", "export_id"))


def build_question_id(idempotency_key: str) -> str:
    safe_key = idempotency_key.replace(":", "_").replace("/", "_")
    return f"pf-question-{safe_key}"


def transition_roundtrip(
    fixture: Dict[str, object],
    emitted_by_key: Dict[str, str],
    reference_time: datetime,
) -> Tuple[str, Optional[str], str]:
    source = fixture.get("source")
    source_metadata = source if isinstance(source, dict) else {}
    idempotency_key = str(fixture.get("idempotency_key", ""))

    if fixture.get("contract_version") != CONTRACT_VERSION:
        return "missing_source_metadata", None, "contract_version_mismatch"

    if not idempotency_key or not required_source_metadata_present(source_metadata):
        return "missing_source_metadata", None, "required_source_metadata_absent"

    if idempotency_key in emitted_by_key:
        return "duplicate_suppressed", emitted_by_key[idempotency_key], "idempotency_key_already_emitted"

    observed_at = parse_utc(str(fixture["observed_at"]))
    age_seconds = int((reference_time - observed_at).total_seconds())
    if age_seconds > STALE_AFTER_SECONDS:
        return "stale_input", None, "observation_older_than_contract_ttl"

    privacy_flags = fixture.get("privacy_flags", [])
    if privacy_flags:
        return "privacy_blocked", None, "privacy_flags_present"

    confidence = float(fixture.get("confidence", 0.0))
    if confidence < LOW_CONFIDENCE_THRESHOLD:
        return "low_confidence_escalated", None, "confidence_below_emission_floor"

    question_id = build_question_id(idempotency_key)
    emitted_by_key[idempotency_key] = question_id
    return "question_emitted", question_id, "accepted_observation_generated_question"


def simulate_roundtrips(fixtures: Iterable[Dict[str, object]]) -> Dict[str, object]:
    reference_time = parse_utc(REFERENCE_TIME)
    emitted_by_key: Dict[str, str] = {}
    transition_counts = {state: 0 for state in TRANSITION_ORDER}
    receipts: List[Dict[str, object]] = []

    for sequence, fixture in enumerate(fixtures, start=1):
        decision, question_id, reason = transition_roundtrip(
            fixture=fixture,
            emitted_by_key=emitted_by_key,
            reference_time=reference_time,
        )
        transition_counts[decision] += 1
        source = fixture.get("source") if isinstance(fixture.get("source"), dict) else {}

        receipts.append(
            {
                "sequence": sequence,
                "case_id": fixture["case_id"],
                "idempotency_key": fixture.get("idempotency_key"),
                "source_app": source.get("app_id"),
                "outbound_state": "observation_received",
                "inbound_state": decision,
                "question_id": question_id,
                "reason": reason,
            }
        )

    return {
        "simulator_version": SIMULATOR_VERSION,
        "contract_version": CONTRACT_VERSION,
        "total_roundtrips": len(receipts),
        "transition_counts": transition_counts,
        "duplicate_suppression_count": transition_counts["duplicate_suppressed"],
        "stale_input_count": transition_counts["stale_input"],
        "privacy_block_count": transition_counts["privacy_blocked"],
        "question_emission_count": transition_counts["question_emitted"],
        "escalation_count": transition_counts["low_confidence_escalated"],
        "transition_receipts": receipts,
    }


def main() -> None:
    print(json.dumps(simulate_roundtrips(FIXTURES), indent=2))


if __name__ == "__main__":
    main()
