#!/usr/bin/env python3
"""Build, run, score, and gate blind PR-review evaluations."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable


SCHEMA_VERSION = 1
MATERIAL_SEVERITIES = {"High", "Middle"}
PUBLISHABLE_CONFIDENCES = {"high", "medium"}
ALLOWED_VERDICTS = {"KEEP", "DOWNGRADE", "REJECT", "REVIEW"}
ALLOWED_SEVERITIES = {"High", "Middle", "Low", "Nit"}
ALLOWED_SIDES = {"LEFT", "RIGHT"}
ALLOWED_COVERAGE = {"complete", "partial", "blocked"}
LOWER_IS_BETTER_METRICS = {
    "false_positives_per_case",
    "invalid_output_rate",
    "negative_fp_per_pr",
    "negative_fp_rate",
}
FORBIDDEN_PUBLIC_KEYS = {
    "accepted_matchers",
    "evidence_level",
    "expected_findings",
    "ground_truth",
    "negative_reason",
    "oracle",
    "severity",
    "truth_id",
}
HUNK_RE = re.compile(
    r"^@@ -(?P<old>\d+)(?:,(?P<old_count>\d+))? "
    r"\+(?P<new>\d+)(?:,(?P<new_count>\d+))? @@"
)


class EvalError(ValueError):
    """Raised when an evaluation artifact violates its contract."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Operate the deterministic blind review evaluation harness."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate", help="validate corpus and oracle")
    add_corpus_args(validate, include_schema=True)

    pack = subparsers.add_parser("pack", help="create an oracle-free reviewer pack")
    pack.add_argument("--cases", required=True, type=Path)
    pack.add_argument("--taxonomy", required=True, type=Path)
    pack.add_argument("--prediction-schema", required=True, type=Path)
    pack.add_argument("--prompt", required=True, type=Path)
    pack.add_argument("--skill-root", required=True, type=Path)
    pack.add_argument("--run-id", required=True)
    pack.add_argument("--replicate-id", required=True, type=positive_int)
    pack.add_argument("--shuffle-seed", required=True, type=int)
    pack.add_argument("--reviewer-name", required=True)
    pack.add_argument("--model", default="default")
    pack.add_argument("--model-version", default="unknown")
    pack.add_argument("--reasoning-effort", default="default")
    pack.add_argument(
        "--isolation-mode",
        choices=("verified", "best-effort"),
        default="best-effort",
        help="whether the reviewer was proven unable to reach oracle/history roots",
    )
    pack.add_argument("--output", required=True, type=Path)

    run = subparsers.add_parser("run", help="run Codex against one blind pack")
    run.add_argument("--pack", required=True, type=Path)
    run.add_argument("--output", required=True, type=Path)
    run.add_argument("--codex-bin", default="codex")
    run.add_argument("--timeout-seconds", type=positive_int, default=1800)
    run.add_argument(
        "--deny-read-root",
        action="append",
        default=[],
        type=Path,
        help="macOS root hidden from the reviewer; required by verified packs",
    )

    score = subparsers.add_parser("score", help="score one prediction artifact")
    score.add_argument("--pack", required=True, type=Path)
    score.add_argument("--truth", required=True, type=Path)
    score.add_argument("--predictions", required=True, type=Path)
    score.add_argument(
        "--execution-mode", choices=("live", "replay"), default="live"
    )
    score.add_argument("--output", required=True, type=Path)

    aggregate = subparsers.add_parser(
        "aggregate", help="pool multiple fresh replicate reports"
    )
    aggregate.add_argument("--score", action="append", required=True, type=Path)
    aggregate.add_argument("--measurement-id", required=True)
    aggregate.add_argument("--output", required=True, type=Path)

    compare = subparsers.add_parser(
        "compare", help="apply absolute and baseline regression gates"
    )
    compare.add_argument("--candidate", required=True, type=Path)
    compare.add_argument("--baseline", required=True, type=Path)
    compare.add_argument("--policy", required=True, type=Path)
    compare.add_argument("--output", required=True, type=Path)

    record = subparsers.add_parser(
        "record", help="append an aggregate to immutable JSONL history"
    )
    record.add_argument("--aggregate", required=True, type=Path)
    record.add_argument("--history", required=True, type=Path)

    return parser.parse_args(argv)


def add_corpus_args(parser: argparse.ArgumentParser, *, include_schema: bool) -> None:
    parser.add_argument("--cases", required=True, type=Path)
    parser.add_argument("--truth", required=True, type=Path)
    parser.add_argument("--taxonomy", required=True, type=Path)
    if include_schema:
        parser.add_argument("--prediction-schema", required=True, type=Path)


def positive_int(raw: str) -> int:
    value = int(raw)
    if value < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return value


def expect_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EvalError(f"{label} must be a JSON object")
    return value


def expect_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise EvalError(f"{label} must be a JSON array")
    return value


def expect_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise EvalError(f"{label} must be a non-empty trimmed string")
    return value


def expect_int(value: Any, label: str, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise EvalError(f"{label} must be an integer >= {minimum}")
    return value


def expect_enum(value: Any, label: str, allowed: set[str]) -> str:
    normalized = expect_string(value, label)
    if normalized not in allowed:
        raise EvalError(f"{label} must be one of {sorted(allowed)}")
    return normalized


def expect_exact_keys(value: dict[str, Any], label: str, allowed: set[str]) -> None:
    unexpected = sorted(set(value) - allowed)
    missing = sorted(allowed - set(value))
    if unexpected or missing:
        details = []
        if missing:
            details.append(f"missing={missing}")
        if unexpected:
            details.append(f"unexpected={unexpected}")
        raise EvalError(f"{label} has invalid keys: {', '.join(details)}")


def load_json(path: Path, label: str) -> dict[str, Any]:
    if path.is_symlink():
        raise EvalError(f"{label} must not be a symlink: {path}")
    try:
        return expect_object(json.loads(path.read_text(encoding="utf-8")), label)
    except OSError as error:
        raise EvalError(f"cannot read {label}: {error}") from error
    except json.JSONDecodeError as error:
        raise EvalError(f"invalid JSON in {label}: {error}") from error


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest_json(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def normalized_cases(cases: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": cases["schema_version"],
        "corpus_version": cases["corpus_version"],
        "cases": sorted(cases["cases"], key=lambda item: item["case_id"]),
    }


def normalized_taxonomy(taxonomy: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": taxonomy["schema_version"],
        "taxonomy_version": taxonomy["taxonomy_version"],
        "issue_codes": sorted(
            taxonomy["issue_codes"], key=lambda item: item["code"]
        ),
    }


def normalized_truth(truth: dict[str, Any]) -> dict[str, Any]:
    copied = copy.deepcopy(truth)
    copied["cases"] = sorted(copied["cases"], key=lambda item: item["case_id"])
    for case in copied["cases"]:
        case["findings"] = sorted(
            case["findings"], key=lambda item: item["truth_id"]
        )
    return copied


def build_public_diffmap(cases: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "corpus_version": cases["corpus_version"],
        "cases": [
            {
                "case_id": case["case_id"],
                "files": [
                    {
                        "path": changed_file["path"],
                        "reviewable_changed_lines": {
                            side: sorted(lines)
                            for side, lines in parse_patch_changed_lines(
                                changed_file["patch"],
                                f"{case['case_id']}:{changed_file['path']}",
                            ).items()
                        },
                    }
                    for changed_file in case["changed_files"]
                ],
            }
            for case in cases["cases"]
        ],
    }


def normalized_diffmap(diffmap: dict[str, Any]) -> dict[str, Any]:
    copied = copy.deepcopy(diffmap)
    copied["cases"] = sorted(copied["cases"], key=lambda item: item["case_id"])
    for case in copied["cases"]:
        case["files"] = sorted(case["files"], key=lambda item: item["path"])
    return copied


def safe_relative_path(raw: Any, label: str) -> str:
    path = expect_string(raw, label)
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts:
        raise EvalError(f"{label} must be a safe repository-relative path")
    return path


def parse_patch_changed_lines(
    patch: str, label: str
) -> dict[str, set[int]]:
    changed = {"LEFT": set(), "RIGHT": set()}
    old_line: int | None = None
    new_line: int | None = None
    expected_old = expected_new = seen_old = seen_new = 0
    hunk_count = 0

    def finish_hunk() -> None:
        if old_line is None or new_line is None:
            return
        if seen_old != expected_old or seen_new != expected_new:
            raise EvalError(f"{label} has an incomplete unified-diff hunk")

    for raw_line in patch.splitlines():
        hunk = HUNK_RE.match(raw_line)
        if hunk:
            finish_hunk()
            old_line = int(hunk.group("old"))
            new_line = int(hunk.group("new"))
            expected_old = int(hunk.group("old_count") or "1")
            expected_new = int(hunk.group("new_count") or "1")
            seen_old = seen_new = 0
            hunk_count += 1
            continue
        if old_line is None or new_line is None:
            continue
        if raw_line.startswith("\\"):
            continue
        if raw_line.startswith("+"):
            changed["RIGHT"].add(new_line)
            new_line += 1
            seen_new += 1
        elif raw_line.startswith("-"):
            changed["LEFT"].add(old_line)
            old_line += 1
            seen_old += 1
        elif raw_line.startswith(" "):
            old_line += 1
            new_line += 1
            seen_old += 1
            seen_new += 1
        else:
            raise EvalError(f"{label} contains an invalid hunk line")
    finish_hunk()
    if hunk_count == 0:
        raise EvalError(f"{label} must contain at least one unified-diff hunk")
    return changed


def validate_public_keys(value: Any, label: str) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if key in FORBIDDEN_PUBLIC_KEYS:
                raise EvalError(f"{label} leaks forbidden oracle key: {key}")
            validate_public_keys(nested, f"{label}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            validate_public_keys(nested, f"{label}[{index}]")


def validate_cases(raw: dict[str, Any]) -> dict[str, Any]:
    expect_exact_keys(raw, "cases", {"schema_version", "corpus_version", "cases"})
    if raw.get("schema_version") != SCHEMA_VERSION:
        raise EvalError("cases.schema_version must be 1")
    corpus_version = expect_string(raw.get("corpus_version"), "cases.corpus_version")
    cases = expect_list(raw.get("cases"), "cases.cases")
    if len(cases) < 1:
        raise EvalError("cases.cases must not be empty")

    seen_ids: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, raw_case in enumerate(cases):
        case = expect_object(raw_case, f"cases.cases[{index}]")
        expect_exact_keys(
            case,
            f"cases.cases[{index}]",
            {
                "case_id",
                "title",
                "pr_body",
                "base_sha",
                "head_sha",
                "rules",
                "changed_files",
                "context_files",
                "checks",
            },
        )
        validate_public_keys(case, f"cases.cases[{index}]")
        case_id = expect_string(case.get("case_id"), f"cases[{index}].case_id")
        if case_id in seen_ids:
            raise EvalError(f"duplicate case_id: {case_id}")
        seen_ids.add(case_id)
        expect_string(case.get("title"), f"{case_id}.title")
        expect_string(case.get("pr_body"), f"{case_id}.pr_body")
        base_sha = expect_string(case.get("base_sha"), f"{case_id}.base_sha")
        head_sha = expect_string(case.get("head_sha"), f"{case_id}.head_sha")
        for name, sha in (("base_sha", base_sha), ("head_sha", head_sha)):
            if len(sha) not in {40, 64} or any(ch not in "0123456789abcdef" for ch in sha):
                raise EvalError(f"{case_id}.{name} must be a lowercase Git object ID")
        if base_sha == head_sha:
            raise EvalError(f"{case_id} base_sha and head_sha must differ")
        for field in ("rules", "checks"):
            values = expect_list(case.get(field), f"{case_id}.{field}")
            for value_index, value in enumerate(values):
                expect_string(value, f"{case_id}.{field}[{value_index}]")
        changed_files = expect_list(case.get("changed_files"), f"{case_id}.changed_files")
        if not changed_files:
            raise EvalError(f"{case_id}.changed_files must not be empty")
        changed_paths: set[str] = set()
        for file_index, raw_file in enumerate(changed_files):
            file_info = expect_object(raw_file, f"{case_id}.changed_files[{file_index}]")
            expect_exact_keys(
                file_info,
                f"{case_id}.changed_files[{file_index}]",
                {"path", "patch"},
            )
            path = safe_relative_path(
                file_info.get("path"), f"{case_id}.changed_files[{file_index}].path"
            )
            if path in changed_paths:
                raise EvalError(f"{case_id} has duplicate changed path: {path}")
            changed_paths.add(path)
            expect_string(
                file_info.get("patch"), f"{case_id}.changed_files[{file_index}].patch"
            )
            parse_patch_changed_lines(
                file_info["patch"], f"{case_id}.changed_files[{file_index}].patch"
            )
        context_files = expect_list(case.get("context_files"), f"{case_id}.context_files")
        for file_index, raw_file in enumerate(context_files):
            file_info = expect_object(raw_file, f"{case_id}.context_files[{file_index}]")
            expect_exact_keys(
                file_info,
                f"{case_id}.context_files[{file_index}]",
                {"path", "content"},
            )
            safe_relative_path(
                file_info.get("path"), f"{case_id}.context_files[{file_index}].path"
            )
            expect_string(
                file_info.get("content"), f"{case_id}.context_files[{file_index}].content"
            )
        normalized.append(case)

    return {
        "schema_version": SCHEMA_VERSION,
        "corpus_version": corpus_version,
        "cases": normalized,
    }


def validate_taxonomy(raw: dict[str, Any]) -> dict[str, Any]:
    expect_exact_keys(
        raw,
        "taxonomy",
        {"schema_version", "taxonomy_version", "issue_codes"},
    )
    if raw.get("schema_version") != SCHEMA_VERSION:
        raise EvalError("taxonomy.schema_version must be 1")
    version = expect_string(raw.get("taxonomy_version"), "taxonomy.taxonomy_version")
    issue_codes = expect_list(raw.get("issue_codes"), "taxonomy.issue_codes")
    seen_codes: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, raw_entry in enumerate(issue_codes):
        entry = expect_object(raw_entry, f"taxonomy.issue_codes[{index}]")
        expect_exact_keys(
            entry,
            f"taxonomy.issue_codes[{index}]",
            {"code", "category", "description"},
        )
        code = expect_string(entry.get("code"), f"taxonomy.issue_codes[{index}].code")
        if code in seen_codes:
            raise EvalError(f"duplicate taxonomy code: {code}")
        seen_codes.add(code)
        expect_string(entry.get("category"), f"taxonomy.{code}.category")
        expect_string(entry.get("description"), f"taxonomy.{code}.description")
        normalized.append(entry)
    if not normalized:
        raise EvalError("taxonomy.issue_codes must not be empty")
    return {
        "schema_version": SCHEMA_VERSION,
        "taxonomy_version": version,
        "issue_codes": normalized,
    }


def validate_truth(
    raw: dict[str, Any], cases: dict[str, Any], taxonomy: dict[str, Any]
) -> dict[str, Any]:
    expect_exact_keys(raw, "truth", {"schema_version", "corpus_version", "cases"})
    if raw.get("schema_version") != SCHEMA_VERSION:
        raise EvalError("truth.schema_version must be 1")
    if raw.get("corpus_version") != cases["corpus_version"]:
        raise EvalError("truth.corpus_version must match cases")
    raw_cases = expect_list(raw.get("cases"), "truth.cases")
    expected_case_ids = {case["case_id"] for case in cases["cases"]}
    taxonomy_by_code = {entry["code"]: entry for entry in taxonomy["issue_codes"]}
    changed_paths_by_case = {
        case["case_id"]: {entry["path"] for entry in case["changed_files"]}
        for case in cases["cases"]
    }
    changed_lines_by_case = {
        case["case_id"]: {
            entry["path"]: parse_patch_changed_lines(
                entry["patch"], f"{case['case_id']}:{entry['path']}"
            )
            for entry in case["changed_files"]
        }
        for case in cases["cases"]
    }
    seen_case_ids: set[str] = set()
    seen_truth_ids: set[str] = set()
    normalized_cases: list[dict[str, Any]] = []

    for index, raw_case in enumerate(raw_cases):
        truth_case = expect_object(raw_case, f"truth.cases[{index}]")
        expect_exact_keys(
            truth_case,
            f"truth.cases[{index}]",
            {"case_id", "case_kind", "negative_reason", "findings"},
        )
        case_id = expect_string(truth_case.get("case_id"), f"truth.cases[{index}].case_id")
        if case_id not in expected_case_ids:
            raise EvalError(f"truth references unknown case_id: {case_id}")
        if case_id in seen_case_ids:
            raise EvalError(f"duplicate truth case_id: {case_id}")
        seen_case_ids.add(case_id)
        case_kind = expect_enum(
            truth_case.get("case_kind"), f"{case_id}.case_kind", {"regression", "no-finding"}
        )
        negative_reason = truth_case.get("negative_reason")
        if negative_reason is not None:
            expect_string(negative_reason, f"{case_id}.negative_reason")
        findings = expect_list(truth_case.get("findings"), f"{case_id}.findings")
        if case_kind == "regression" and not findings:
            raise EvalError(f"{case_id} regression case must contain a finding")
        if case_kind == "no-finding" and findings:
            raise EvalError(f"{case_id} no-finding case must not contain findings")

        matcher_ranges: list[tuple[str, str, str, str, int, int, str]] = []
        normalized_findings: list[dict[str, Any]] = []
        for finding_index, raw_finding in enumerate(findings):
            finding = expect_object(raw_finding, f"{case_id}.findings[{finding_index}]")
            expect_exact_keys(
                finding,
                f"{case_id}.findings[{finding_index}]",
                {"truth_id", "severity", "evidence_level", "accepted_matchers"},
            )
            truth_id = expect_string(finding.get("truth_id"), f"{case_id}.truth_id")
            if truth_id in seen_truth_ids:
                raise EvalError(f"duplicate truth_id: {truth_id}")
            seen_truth_ids.add(truth_id)
            expect_enum(finding.get("severity"), f"{truth_id}.severity", MATERIAL_SEVERITIES)
            expect_enum(
                finding.get("evidence_level"), f"{truth_id}.evidence_level", {"E2", "E3", "E4"}
            )
            matchers = expect_list(
                finding.get("accepted_matchers"), f"{truth_id}.accepted_matchers"
            )
            if not matchers:
                raise EvalError(f"{truth_id}.accepted_matchers must not be empty")
            for matcher_index, raw_matcher in enumerate(matchers):
                matcher = expect_object(raw_matcher, f"{truth_id}.matchers[{matcher_index}]")
                expect_exact_keys(
                    matcher,
                    f"{truth_id}.matchers[{matcher_index}]",
                    {"issue_code", "category", "path", "anchors"},
                )
                code = expect_string(matcher.get("issue_code"), f"{truth_id}.issue_code")
                if code not in taxonomy_by_code:
                    raise EvalError(f"{truth_id} uses unknown issue_code: {code}")
                category = expect_string(matcher.get("category"), f"{truth_id}.category")
                if category != taxonomy_by_code[code]["category"]:
                    raise EvalError(f"{truth_id} category does not match taxonomy for {code}")
                path = safe_relative_path(matcher.get("path"), f"{truth_id}.path")
                if path not in changed_paths_by_case[case_id]:
                    raise EvalError(f"{truth_id} anchor path is not changed in {case_id}")
                anchors = expect_list(matcher.get("anchors"), f"{truth_id}.anchors")
                if not anchors:
                    raise EvalError(f"{truth_id}.anchors must not be empty")
                for anchor_index, raw_anchor in enumerate(anchors):
                    anchor = expect_object(raw_anchor, f"{truth_id}.anchors[{anchor_index}]")
                    expect_exact_keys(
                        anchor,
                        f"{truth_id}.anchors[{anchor_index}]",
                        {"side", "start", "end"},
                    )
                    side = expect_enum(
                        anchor.get("side"), f"{truth_id}.anchors[{anchor_index}].side", ALLOWED_SIDES
                    )
                    start = expect_int(
                        anchor.get("start"), f"{truth_id}.anchors[{anchor_index}].start", minimum=1
                    )
                    end = expect_int(
                        anchor.get("end"), f"{truth_id}.anchors[{anchor_index}].end", minimum=1
                    )
                    if end < start:
                        raise EvalError(f"{truth_id} anchor end must be >= start")
                    reviewable_lines = changed_lines_by_case[case_id][path][side]
                    if not set(range(start, end + 1)).issubset(reviewable_lines):
                        raise EvalError(
                            f"{truth_id} anchor is not wholly on changed {side} lines"
                        )
                    for (
                        prior_code,
                        prior_category,
                        prior_path,
                        prior_side,
                        prior_start,
                        prior_end,
                        prior_truth_id,
                    ) in matcher_ranges:
                        same_semantics = (
                            code == prior_code
                            and category == prior_category
                            and path == prior_path
                            and side == prior_side
                        )
                        overlaps = start <= prior_end and prior_start <= end
                        if same_semantics and overlaps and truth_id != prior_truth_id:
                            raise EvalError(
                                f"ambiguous matcher overlap in {case_id}: "
                                f"{truth_id} and {prior_truth_id}"
                            )
                    matcher_ranges.append(
                        (code, category, path, side, start, end, truth_id)
                    )
            normalized_findings.append(finding)
        normalized_cases.append(truth_case)

    if seen_case_ids != expected_case_ids:
        missing = sorted(expected_case_ids - seen_case_ids)
        raise EvalError(f"truth is missing cases: {missing}")
    return {
        "schema_version": SCHEMA_VERSION,
        "corpus_version": cases["corpus_version"],
        "cases": normalized_cases,
    }


def validate_closed_schema_objects(value: Any, label: str) -> None:
    if not isinstance(value, dict):
        return
    if value.get("type") == "object":
        if value.get("additionalProperties") is not False:
            raise EvalError(f"{label} must set additionalProperties=false")
        properties = expect_object(value.get("properties"), f"{label}.properties")
        required = set(expect_list(value.get("required"), f"{label}.required"))
        if required != set(properties):
            raise EvalError(f"{label}.required must equal its property set")
    for key, nested in value.items():
        if key in {"properties", "items"}:
            if key == "properties":
                for property_name, property_schema in expect_object(
                    nested, f"{label}.properties"
                ).items():
                    validate_closed_schema_objects(
                        property_schema, f"{label}.properties.{property_name}"
                    )
            else:
                validate_closed_schema_objects(nested, f"{label}.items")


def validate_prediction_schema(
    raw: dict[str, Any],
    taxonomy: dict[str, Any] | None = None,
    corpus_version: str | None = None,
) -> None:
    validate_closed_schema_objects(raw, "prediction schema")
    if raw.get("type") != "object":
        raise EvalError("prediction schema root type must be object")
    properties = expect_object(raw.get("properties"), "prediction schema properties")
    for key in ("schema_version", "corpus_version", "run_id", "reviewer", "cases"):
        if key not in properties:
            raise EvalError(f"prediction schema is missing property: {key}")
    required = set(expect_list(raw.get("required"), "prediction schema required"))
    if not {"schema_version", "corpus_version", "run_id", "reviewer", "cases"}.issubset(required):
        raise EvalError("prediction schema root required fields are incomplete")
    if properties["schema_version"].get("const") != SCHEMA_VERSION:
        raise EvalError("prediction schema must fix schema_version to 1")
    if corpus_version is not None and properties["corpus_version"].get("const") != corpus_version:
        raise EvalError("prediction schema corpus_version must match cases")
    case_schema = expect_object(
        expect_object(properties["cases"].get("items"), "prediction cases.items"),
        "prediction case schema",
    )
    case_properties = expect_object(
        case_schema.get("properties"), "prediction case properties"
    )
    coverage_values = set(
        expect_list(
            expect_object(
                case_properties.get("coverage_status"), "coverage_status schema"
            ).get("enum"),
            "coverage_status enum",
        )
    )
    if coverage_values != ALLOWED_COVERAGE:
        raise EvalError("prediction schema coverage_status enum is out of sync")
    findings_schema = expect_object(
        expect_object(case_properties.get("findings"), "findings schema").get("items"),
        "finding item schema",
    )
    finding_properties = expect_object(
        findings_schema.get("properties"), "finding properties"
    )
    expected_enums = {
        "verdict": ALLOWED_VERDICTS,
        "severity": ALLOWED_SEVERITIES,
        "confidence": {"high", "medium", "low"},
        "side": ALLOWED_SIDES,
    }
    for field, expected in expected_enums.items():
        actual = set(
            expect_list(
                expect_object(finding_properties.get(field), f"{field} schema").get("enum"),
                f"{field} enum",
            )
        )
        if actual != expected:
            raise EvalError(f"prediction schema {field} enum is out of sync")
    if taxonomy is not None:
        expected_codes = {entry["code"] for entry in taxonomy["issue_codes"]}
        expected_categories = {entry["category"] for entry in taxonomy["issue_codes"]}
        actual_codes = set(
            expect_list(
                expect_object(
                    finding_properties.get("issue_code"), "issue_code schema"
                ).get("enum"),
                "issue_code enum",
            )
        )
        actual_categories = set(
            expect_list(
                expect_object(
                    finding_properties.get("category"), "category schema"
                ).get("enum"),
                "category enum",
            )
        )
        if actual_codes != expected_codes:
            raise EvalError("prediction schema issue_code enum does not match taxonomy")
        if actual_categories != expected_categories:
            raise EvalError("prediction schema category enum does not match taxonomy")


def validate_corpus_bundle(
    cases_path: Path,
    truth_path: Path,
    taxonomy_path: Path,
    schema_path: Path,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    cases = validate_cases(load_json(cases_path, "cases"))
    taxonomy = validate_taxonomy(load_json(taxonomy_path, "taxonomy"))
    truth = validate_truth(load_json(truth_path, "truth"), cases, taxonomy)
    schema = load_json(schema_path, "prediction schema")
    validate_prediction_schema(schema, taxonomy, cases["corpus_version"])
    return cases, truth, taxonomy, schema


def hash_tree(root: Path) -> str:
    if root.is_symlink() or not root.is_dir():
        raise EvalError(f"snapshot root must be a real directory: {root}")
    digest = hashlib.sha256()
    files = sorted(path for path in root.rglob("*") if path.is_file())
    for path in files:
        if path.is_symlink():
            raise EvalError(f"snapshot must not contain symlinks: {path}")
        relative = path.relative_to(root).as_posix()
        if "__pycache__" in path.parts or relative.endswith(".pyc") or relative == ".DS_Store":
            continue
        digest.update(relative.encode("utf-8") + b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def source_digest() -> str:
    return sha256_bytes(Path(__file__).read_bytes())


def filtered_environment() -> dict[str, str]:
    """Pass only process basics; never leak repository/cloud credentials to a reviewer."""
    allowed = {
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "SHELL",
        "TERM",
        "TMPDIR",
        "USER",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    environment["NO_COLOR"] = "1"
    return environment


def copy_skill_snapshot(skill_root: Path, destination: Path) -> None:
    if skill_root.is_symlink() or not skill_root.is_dir():
        raise EvalError("skill_root must be a real directory")
    required = [skill_root / "SKILL.md", skill_root / "references"]
    if not required[0].is_file() or not required[1].is_dir():
        raise EvalError("skill_root must contain SKILL.md and references/")
    destination.mkdir(parents=True, exist_ok=False)
    shutil.copy2(required[0], destination / "SKILL.md")
    references_output = destination / "references"
    references_output.mkdir()
    for source in sorted(required[1].rglob("*.md")):
        if source.is_symlink():
            raise EvalError(f"skill reference must not be a symlink: {source}")
        relative = source.relative_to(required[1])
        target = references_output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def command_validate(args: argparse.Namespace) -> int:
    cases, truth, taxonomy, schema = validate_corpus_bundle(
        args.cases, args.truth, args.taxonomy, args.prediction_schema
    )
    summary = {
        "status": "valid",
        "corpus_version": cases["corpus_version"],
        "case_count": len(cases["cases"]),
        "truth_count": sum(len(case["findings"]) for case in truth["cases"]),
        "taxonomy_count": len(taxonomy["issue_codes"]),
        "cases_digest": digest_json(normalized_cases(cases)),
        "truth_digest": digest_json(normalized_truth(truth)),
        "taxonomy_digest": digest_json(normalized_taxonomy(taxonomy)),
        "schema_digest": digest_json(schema),
    }
    sys.stdout.write(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return 0


def command_pack(args: argparse.Namespace) -> int:
    cases = validate_cases(load_json(args.cases, "cases"))
    taxonomy = validate_taxonomy(load_json(args.taxonomy, "taxonomy"))
    schema = load_json(args.prediction_schema, "prediction schema")
    validate_prediction_schema(schema, taxonomy, cases["corpus_version"])
    prompt_text = args.prompt.read_text(encoding="utf-8")
    if not prompt_text.strip():
        raise EvalError("reviewer prompt must not be empty")
    if args.output.exists():
        raise EvalError(f"pack output already exists: {args.output}")

    shuffled_cases = copy.deepcopy(cases)
    random.Random(args.shuffle_seed).shuffle(shuffled_cases["cases"])
    public_diffmap = build_public_diffmap(shuffled_cases)
    args.output.mkdir(parents=True)
    skill_snapshot = args.output / "skill-snapshot"
    copy_skill_snapshot(args.skill_root, skill_snapshot)

    output_schema = copy.deepcopy(schema)
    output_schema["properties"]["schema_version"]["const"] = SCHEMA_VERSION
    output_schema["properties"]["corpus_version"]["const"] = cases["corpus_version"]
    output_schema["properties"]["run_id"]["const"] = args.run_id

    reviewer_profile = {
        "name": expect_string(args.reviewer_name, "reviewer_name"),
        "model": expect_string(args.model, "model"),
        "version": expect_string(args.model_version, "model_version"),
        "reasoning_effort": expect_string(args.reasoning_effort, "reasoning_effort"),
    }
    model_digest = digest_json(reviewer_profile)
    tool_policy = {
        "filesystem": (
            "external-pack-read-only-plus-workspace-deny"
            if args.isolation_mode == "verified"
            else "read-only"
        ),
        "working_directory": "public-pack",
        "network": "runtime-default",
        "credential_environment": "allowlist-filtered",
        "user_rules": "ignored",
    }
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "corpus_version": cases["corpus_version"],
        "run_id": expect_string(args.run_id, "run_id"),
        "replicate_id": args.replicate_id,
        "shuffle_seed": args.shuffle_seed,
        "shuffle_seed_effective": True,
        "model_seed_effective": False,
        "case_ids": [case["case_id"] for case in shuffled_cases["cases"]],
        "cases_digest": digest_json(normalized_cases(cases)),
        "diffmap_digest": digest_json(normalized_diffmap(public_diffmap)),
        "taxonomy_digest": digest_json(normalized_taxonomy(taxonomy)),
        "schema_digest": digest_json(output_schema),
        "prompt_digest": sha256_bytes(prompt_text.encode("utf-8")),
        "skill_digest": hash_tree(skill_snapshot),
        "scorer_digest": source_digest(),
        "model_digest": model_digest,
        "tool_policy_digest": digest_json(tool_policy),
        "reviewer": reviewer_profile,
        "tool_policy": tool_policy,
        "blind": args.isolation_mode == "verified",
        "isolation": {
            "oracle_in_pack": False,
            "previous_outputs_in_pack": False,
            "skill_snapshot_only": True,
            "mode": args.isolation_mode,
        },
    }
    write_json(args.output / "cases.json", shuffled_cases)
    write_json(args.output / "diffmap.json", public_diffmap)
    write_json(args.output / "issue-taxonomy.json", taxonomy)
    write_json(args.output / "prediction.schema.json", output_schema)
    write_json(args.output / "manifest.json", manifest)
    (args.output / "reviewer-prompt.md").write_text(prompt_text, encoding="utf-8")

    forbidden_names = {"oracle", "truth", "ground-truth", "baseline", "history"}
    for path in args.output.rglob("*"):
        if path.is_symlink():
            raise EvalError(f"blind pack contains symlink: {path}")
        if path.name.lower() in forbidden_names:
            raise EvalError(f"blind pack contains forbidden artifact: {path.name}")
        if path.is_file() and path.stat().st_nlink != 1:
            raise EvalError(f"blind pack contains hard-linked artifact: {path}")

    sys.stdout.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return 0


def command_run(args: argparse.Namespace) -> int:
    pack = args.pack.resolve()
    manifest = load_json(pack / "manifest.json", "pack manifest")
    prompt = (pack / "reviewer-prompt.md").read_text(encoding="utf-8")
    schema = pack / "prediction.schema.json"
    if not schema.is_file():
        raise EvalError("pack prediction.schema.json is missing")
    if args.output.exists():
        raise EvalError(f"prediction output already exists: {args.output}")
    args.output.parent.mkdir(parents=True, exist_ok=True)

    reviewer = expect_object(manifest.get("reviewer"), "manifest.reviewer")
    codex_command = [
        args.codex_bin,
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-C",
        str(pack),
        "--output-schema",
        str(schema),
        "--output-last-message",
        str(args.output.resolve()),
    ]
    model = expect_string(reviewer.get("model"), "manifest.reviewer.model")
    if model != "default":
        codex_command.extend(["--model", model])
    reasoning = expect_string(
        reviewer.get("reasoning_effort"), "manifest.reviewer.reasoning_effort"
    )
    if reasoning != "default":
        codex_command.extend(["-c", f'model_reasoning_effort="{reasoning}"'])
    codex_command.append("-")

    deny_roots: list[Path] = []
    for raw_root in args.deny_read_root:
        resolved = raw_root.resolve()
        if not resolved.is_dir() or resolved == Path("/"):
            raise EvalError(f"deny-read root must be a specific existing directory: {resolved}")
        if pack == resolved or resolved in pack.parents:
            raise EvalError("deny-read root must not contain the public pack")
        deny_roots.append(resolved)
    if manifest.get("blind") is True and not deny_roots:
        raise EvalError("verified blind packs require at least one --deny-read-root")

    if deny_roots:
        codex_command.insert(6, "--dangerously-bypass-approvals-and-sandbox")
    else:
        codex_command[6:6] = ["--sandbox", "read-only"]

    command = codex_command
    if deny_roots:
        sandbox_exec = Path("/usr/bin/sandbox-exec")
        if not sandbox_exec.is_file():
            raise EvalError("--deny-read-root requires macOS sandbox-exec")
        clauses = []
        for root in sorted(set(deny_roots)):
            escaped = str(root).replace("\\", "\\\\").replace('"', '\\"')
            clauses.append(f'(deny file-read* (subpath "{escaped}"))')
            clauses.append(f'(deny file-write* (subpath "{escaped}"))')
        escaped_pack = str(pack).replace("\\", "\\\\").replace('"', '\\"')
        clauses.append(f'(deny file-write* (subpath "{escaped_pack}"))')
        profile = "(version 1) (allow default) " + " ".join(clauses)
        command = [str(sandbox_exec), "-p", profile, *codex_command]

    environment = filtered_environment()
    try:
        completed = subprocess.run(
            command,
            input=prompt,
            text=True,
            check=False,
            capture_output=True,
            timeout=args.timeout_seconds,
            env=environment,
            cwd=pack,
        )
    except subprocess.TimeoutExpired as error:
        raise EvalError(f"Codex evaluation timed out after {args.timeout_seconds}s") from error
    if completed.returncode != 0:
        tail = completed.stderr[-2000:]
        raise EvalError(f"Codex evaluation failed ({completed.returncode}): {tail}")
    if not args.output.is_file():
        raise EvalError("Codex completed without writing predictions")
    cases = validate_cases(load_json(pack / "cases.json", "pack cases"))
    diffmap = load_json(pack / "diffmap.json", "pack diffmap")
    if digest_json(normalized_diffmap(diffmap)) != manifest.get("diffmap_digest"):
        raise EvalError("pack diffmap digest does not match manifest")
    taxonomy = validate_taxonomy(
        load_json(pack / "issue-taxonomy.json", "pack taxonomy")
    )
    validate_predictions(
        load_json(args.output, "predictions"), manifest, cases, taxonomy
    )
    return 0


def validate_predictions(
    raw: dict[str, Any],
    manifest: dict[str, Any],
    cases: dict[str, Any],
    taxonomy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    expect_exact_keys(
        raw,
        "predictions",
        {"schema_version", "corpus_version", "run_id", "reviewer", "cases"},
    )
    if raw.get("schema_version") != SCHEMA_VERSION:
        raise EvalError("predictions.schema_version must be 1")
    if raw.get("corpus_version") != manifest.get("corpus_version"):
        raise EvalError("predictions.corpus_version must match pack")
    if raw.get("run_id") != manifest.get("run_id"):
        raise EvalError("predictions.run_id must match pack")
    reviewer = expect_object(raw.get("reviewer"), "predictions.reviewer")
    expect_exact_keys(reviewer, "predictions.reviewer", {"name", "model", "version"})
    expected_reviewer = expect_object(manifest.get("reviewer"), "manifest.reviewer")
    for field in ("name", "model", "version"):
        if reviewer.get(field) != expected_reviewer.get(field):
            raise EvalError(f"predictions.reviewer.{field} must match pack")

    cases_by_id = {case["case_id"]: case for case in cases["cases"]}
    raw_cases = expect_list(raw.get("cases"), "predictions.cases")
    seen_cases: set[str] = set()
    seen_predictions: set[str] = set()
    normalized_cases: list[dict[str, Any]] = []
    for index, raw_case in enumerate(raw_cases):
        case = expect_object(raw_case, f"predictions.cases[{index}]")
        expect_exact_keys(
            case,
            f"predictions.cases[{index}]",
            {"case_id", "base_sha", "head_sha", "coverage_status", "findings"},
        )
        case_id = expect_string(case.get("case_id"), f"predictions.cases[{index}].case_id")
        if case_id not in cases_by_id:
            raise EvalError(f"predictions contain unknown case_id: {case_id}")
        if case_id in seen_cases:
            raise EvalError(f"predictions contain duplicate case_id: {case_id}")
        seen_cases.add(case_id)
        expected_case = cases_by_id[case_id]
        if case.get("base_sha") != expected_case["base_sha"]:
            raise EvalError(f"{case_id}.base_sha does not match pack")
        if case.get("head_sha") != expected_case["head_sha"]:
            raise EvalError(f"{case_id}.head_sha does not match pack")
        expect_enum(
            case.get("coverage_status"), f"{case_id}.coverage_status", ALLOWED_COVERAGE
        )
        findings = expect_list(case.get("findings"), f"{case_id}.findings")
        for finding_index, raw_finding in enumerate(findings):
            finding = expect_object(raw_finding, f"{case_id}.findings[{finding_index}]")
            expect_exact_keys(
                finding,
                f"{case_id}.findings[{finding_index}]",
                {
                    "prediction_id",
                    "verdict",
                    "severity",
                    "confidence",
                    "issue_code",
                    "category",
                    "path",
                    "side",
                    "line",
                    "claim",
                },
            )
            prediction_id = expect_string(
                finding.get("prediction_id"), f"{case_id}.prediction_id"
            )
            if prediction_id in seen_predictions:
                raise EvalError(f"duplicate prediction_id: {prediction_id}")
            seen_predictions.add(prediction_id)
            expect_enum(finding.get("verdict"), f"{prediction_id}.verdict", ALLOWED_VERDICTS)
            expect_enum(
                finding.get("severity"), f"{prediction_id}.severity", ALLOWED_SEVERITIES
            )
            expect_enum(
                finding.get("confidence"),
                f"{prediction_id}.confidence",
                {"high", "medium", "low"},
            )
            issue_code = expect_string(
                finding.get("issue_code"), f"{prediction_id}.issue_code"
            )
            category = expect_string(
                finding.get("category"), f"{prediction_id}.category"
            )
            if taxonomy is not None:
                taxonomy_by_code = {
                    entry["code"]: entry for entry in taxonomy["issue_codes"]
                }
                if issue_code not in taxonomy_by_code:
                    raise EvalError(f"{prediction_id} uses unknown issue_code")
                if category != taxonomy_by_code[issue_code]["category"]:
                    raise EvalError(
                        f"{prediction_id} category does not match issue_code"
                    )
            safe_relative_path(finding.get("path"), f"{prediction_id}.path")
            expect_enum(finding.get("side"), f"{prediction_id}.side", ALLOWED_SIDES)
            expect_int(finding.get("line"), f"{prediction_id}.line", minimum=1)
            expect_string(finding.get("claim"), f"{prediction_id}.claim")
        normalized_cases.append(case)
    return {
        "schema_version": SCHEMA_VERSION,
        "corpus_version": raw["corpus_version"],
        "run_id": raw["run_id"],
        "reviewer": reviewer,
        "cases": normalized_cases,
    }


def is_actionable(prediction: dict[str, Any]) -> bool:
    return (
        prediction["verdict"] == "KEEP"
        and prediction["severity"] in MATERIAL_SEVERITIES
        and prediction["confidence"] in PUBLISHABLE_CONFIDENCES
    )


def semantic_edge(prediction: dict[str, Any], truth: dict[str, Any]) -> bool:
    return any(
        prediction["issue_code"] == matcher["issue_code"]
        and prediction["category"] == matcher["category"]
        and prediction["path"] == matcher["path"]
        for matcher in truth["accepted_matchers"]
    )


def strict_edge(prediction: dict[str, Any], truth: dict[str, Any]) -> bool:
    for matcher in truth["accepted_matchers"]:
        if prediction["issue_code"] != matcher["issue_code"]:
            continue
        if prediction["category"] != matcher["category"]:
            continue
        if prediction["path"] != matcher["path"]:
            continue
        for anchor in matcher["anchors"]:
            if (
                prediction["side"] == anchor["side"]
                and anchor["start"] <= prediction["line"] <= anchor["end"]
            ):
                return True
    return False


def maximum_matching(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    edge: Callable[[dict[str, Any], dict[str, Any]], bool],
) -> list[tuple[int, int]]:
    adjacency = {
        left_index: [
            right_index
            for right_index, right_item in enumerate(right)
            if edge(left_item, right_item)
        ]
        for left_index, left_item in enumerate(left)
    }
    for values in adjacency.values():
        values.sort(key=lambda index: right[index]["truth_id"])
    right_match: dict[int, int] = {}

    def augment(left_index: int, visited: set[int]) -> bool:
        for right_index in adjacency[left_index]:
            if right_index in visited:
                continue
            visited.add(right_index)
            current = right_match.get(right_index)
            if current is None or augment(current, visited):
                right_match[right_index] = left_index
                return True
        return False

    left_order = sorted(range(len(left)), key=lambda index: left[index]["prediction_id"])
    for left_index in left_order:
        augment(left_index, set())
    return sorted((left_index, right_index) for right_index, left_index in right_match.items())


def metric(tp: int, fp: int, fn: int) -> dict[str, Any]:
    precision_denominator = tp + fp
    recall_denominator = tp + fn
    precision = tp / precision_denominator if precision_denominator else 0.0
    recall = tp / recall_denominator if recall_denominator else 0.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    return {
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "precision_numerator": tp,
        "precision_denominator": precision_denominator,
        "recall_numerator": tp,
        "recall_denominator": recall_denominator,
    }


def score_predictions(
    manifest: dict[str, Any],
    cases: dict[str, Any],
    truth: dict[str, Any],
    predictions: dict[str, Any],
) -> dict[str, Any]:
    truth_by_case = {case["case_id"]: case for case in truth["cases"]}
    predictions_by_case = {case["case_id"]: case for case in predictions["cases"]}
    all_case_ids = sorted(case["case_id"] for case in cases["cases"])
    counts = {
        "material": {"tp": 0, "fp": 0, "fn": 0},
        "High": {"tp": 0, "fp": 0, "fn": 0},
        "Middle": {"tp": 0, "fp": 0, "fn": 0},
        "strict_matches": 0,
        "severity_correct": 0,
        "semantic_localization_errors": 0,
        "semantic_matches": 0,
        "duplicate_false_positives": 0,
        "attribution_false_positives": 0,
        "negative_cases": 0,
        "negative_cases_clean": 0,
        "negative_false_positives": 0,
        "cases_expected": len(all_case_ids),
        "cases_returned": len(predictions_by_case),
        "cases_complete": sum(
            1
            for case in predictions_by_case.values()
            if case["coverage_status"] == "complete"
        ),
    }
    confusion = {"High": {"High": 0, "Middle": 0}, "Middle": {"High": 0, "Middle": 0}}
    case_results: list[dict[str, Any]] = []
    truth_outcomes: list[dict[str, Any]] = []

    for case_id in all_case_ids:
        truth_case = truth_by_case[case_id]
        prediction_case = predictions_by_case.get(case_id)
        raw_predictions = [] if prediction_case is None else prediction_case["findings"]
        actionable = sorted(
            [finding for finding in raw_predictions if is_actionable(finding)],
            key=lambda finding: finding["prediction_id"],
        )
        truths = sorted(truth_case["findings"], key=lambda finding: finding["truth_id"])
        strict_pairs = maximum_matching(actionable, truths, strict_edge)
        strict_pred_indices = {pair[0] for pair in strict_pairs}
        strict_truth_indices = {pair[1] for pair in strict_pairs}
        remaining_predictions = [
            prediction for index, prediction in enumerate(actionable) if index not in strict_pred_indices
        ]
        remaining_truths = [
            finding for index, finding in enumerate(truths) if index not in strict_truth_indices
        ]
        semantic_pairs_local = maximum_matching(
            remaining_predictions, remaining_truths, semantic_edge
        )
        semantic_prediction_ids = {
            remaining_predictions[prediction_index]["prediction_id"]
            for prediction_index, _ in semantic_pairs_local
        }

        counts["material"]["tp"] += len(strict_pairs)
        counts["material"]["fp"] += len(actionable) - len(strict_pairs)
        counts["material"]["fn"] += len(truths) - len(strict_pairs)
        counts["strict_matches"] += len(strict_pairs)
        counts["semantic_localization_errors"] += len(semantic_pairs_local)
        counts["semantic_matches"] += len(strict_pairs) + len(semantic_pairs_local)

        if not truths:
            counts["negative_cases"] += 1
            if not actionable:
                counts["negative_cases_clean"] += 1
            counts["attribution_false_positives"] += len(actionable)
            counts["negative_false_positives"] += len(actionable)

        matched_details: list[dict[str, Any]] = []
        strict_by_truth = {truth_index: pred_index for pred_index, truth_index in strict_pairs}
        for truth_index, truth_finding in enumerate(truths):
            prediction_index = strict_by_truth.get(truth_index)
            detected = prediction_index is not None
            severity_correct = False
            prediction_id = None
            predicted_severity = None
            if detected:
                prediction = actionable[prediction_index]
                prediction_id = prediction["prediction_id"]
                predicted_severity = prediction["severity"]
                severity_correct = predicted_severity == truth_finding["severity"]
                confusion[truth_finding["severity"]][predicted_severity] += 1
                if severity_correct:
                    counts["severity_correct"] += 1
                matched_details.append(
                    {
                        "truth_id": truth_finding["truth_id"],
                        "prediction_id": prediction_id,
                        "severity_correct": severity_correct,
                    }
                )
            truth_outcomes.append(
                {
                    "case_id": case_id,
                    "truth_id": truth_finding["truth_id"],
                    "severity": truth_finding["severity"],
                    "detected": detected,
                    "severity_correct": severity_correct,
                    "prediction_id": prediction_id,
                    "predicted_severity": predicted_severity,
                }
            )

        for severity in ("High", "Middle"):
            predicted_count = sum(
                1 for prediction in actionable if prediction["severity"] == severity
            )
            truth_count = sum(1 for finding in truths if finding["severity"] == severity)
            exact_count = sum(
                1
                for pred_index, truth_index in strict_pairs
                if actionable[pred_index]["severity"] == severity
                and truths[truth_index]["severity"] == severity
            )
            counts[severity]["tp"] += exact_count
            counts[severity]["fp"] += predicted_count - exact_count
            counts[severity]["fn"] += truth_count - exact_count

        duplicate_ids: list[str] = []
        matched_truths = [truths[truth_index] for _, truth_index in strict_pairs]
        strict_truth_codes = {
            matcher["issue_code"]
            for _, truth_index in strict_pairs
            for matcher in truths[truth_index]["accepted_matchers"]
        }
        for index, prediction in enumerate(actionable):
            if index in strict_pred_indices or prediction["prediction_id"] in semantic_prediction_ids:
                continue
            if (
                prediction["issue_code"] in strict_truth_codes
                and any(strict_edge(prediction, finding) for finding in matched_truths)
            ):
                duplicate_ids.append(prediction["prediction_id"])
        counts["duplicate_false_positives"] += len(duplicate_ids)

        case_results.append(
            {
                "case_id": case_id,
                "case_kind": truth_case["case_kind"],
                "coverage_status": None if prediction_case is None else prediction_case["coverage_status"],
                "truth_count": len(truths),
                "actionable_prediction_count": len(actionable),
                "strict_matches": matched_details,
                "localization_error_prediction_ids": sorted(semantic_prediction_ids),
                "duplicate_prediction_ids": sorted(duplicate_ids),
                "false_positive_prediction_ids": sorted(
                    prediction["prediction_id"]
                    for index, prediction in enumerate(actionable)
                    if index not in strict_pred_indices
                ),
                "missed_truth_ids": sorted(
                    truth["truth_id"]
                    for index, truth in enumerate(truths)
                    if index not in strict_truth_indices
                ),
            }
        )

    material_metric = metric(**counts["material"])
    high_metric = metric(**counts["High"])
    middle_metric = metric(**counts["Middle"])
    strict_matches = counts["strict_matches"]
    semantic_matches = counts["semantic_matches"]
    expected_cases = counts["cases_expected"]
    metrics = {
        "material_precision": material_metric["precision"],
        "material_recall": material_metric["recall"],
        "material_f1": material_metric["f1"],
        "high_precision": high_metric["precision"],
        "high_recall": high_metric["recall"],
        "high_f1": high_metric["f1"],
        "middle_precision": middle_metric["precision"],
        "middle_recall": middle_metric["recall"],
        "middle_f1": middle_metric["f1"],
        "severity_agreement": (
            counts["severity_correct"] / strict_matches if strict_matches else 0.0
        ),
        "severity_correct_recall": (
            counts["severity_correct"]
            / (counts["material"]["tp"] + counts["material"]["fn"])
            if counts["material"]["tp"] + counts["material"]["fn"]
            else 0.0
        ),
        "localization_accuracy": (
            strict_matches / semantic_matches if semantic_matches else 0.0
        ),
        "negative_case_accuracy": (
            counts["negative_cases_clean"] / counts["negative_cases"]
            if counts["negative_cases"]
            else 0.0
        ),
        "negative_fp_rate": (
            1.0 - counts["negative_cases_clean"] / counts["negative_cases"]
            if counts["negative_cases"]
            else 0.0
        ),
        "negative_fp_per_pr": (
            counts["negative_false_positives"] / counts["negative_cases"]
            if counts["negative_cases"]
            else 0.0
        ),
        "false_positives_per_case": (
            counts["material"]["fp"] / expected_cases if expected_cases else 0.0
        ),
        "case_coverage": (
            counts["cases_complete"] / expected_cases if expected_cases else 0.0
        ),
        "case_record_coverage": (
            counts["cases_returned"] / expected_cases if expected_cases else 0.0
        ),
        "invalid_output_rate": 0.0,
    }
    return {
        "counts": counts,
        "metrics": metrics,
        "severity_confusion": confusion,
        "case_results": case_results,
        "truth_outcomes": truth_outcomes,
    }


def command_score(args: argparse.Namespace) -> int:
    pack = args.pack.resolve()
    manifest = load_json(pack / "manifest.json", "pack manifest")
    cases = validate_cases(load_json(pack / "cases.json", "pack cases"))
    taxonomy = validate_taxonomy(load_json(pack / "issue-taxonomy.json", "pack taxonomy"))
    truth = validate_truth(load_json(args.truth, "truth"), cases, taxonomy)
    if digest_json(normalized_cases(cases)) != manifest.get("cases_digest"):
        raise EvalError("pack cases digest does not match manifest")
    diffmap = load_json(pack / "diffmap.json", "pack diffmap")
    if digest_json(normalized_diffmap(diffmap)) != manifest.get("diffmap_digest"):
        raise EvalError("pack diffmap digest does not match manifest")
    if digest_json(normalized_taxonomy(taxonomy)) != manifest.get("taxonomy_digest"):
        raise EvalError("pack taxonomy digest does not match manifest")
    if hash_tree(pack / "skill-snapshot") != manifest.get("skill_digest"):
        raise EvalError("pack skill digest does not match manifest")
    if source_digest() != manifest.get("scorer_digest"):
        raise EvalError("scorer source changed after pack creation")
    predictions = validate_predictions(
        load_json(args.predictions, "predictions"), manifest, cases, taxonomy
    )
    scored = score_predictions(manifest, cases, truth, predictions)
    report = {
        "schema_version": SCHEMA_VERSION,
        "status": "valid",
        "execution_mode": args.execution_mode,
        "run_id": manifest["run_id"],
        "replicate_id": manifest["replicate_id"],
        "corpus_version": cases["corpus_version"],
        "cases_digest": manifest["cases_digest"],
        "diffmap_digest": manifest["diffmap_digest"],
        "truth_digest": digest_json(normalized_truth(truth)),
        "taxonomy_digest": manifest["taxonomy_digest"],
        "skill_digest": manifest["skill_digest"],
        "prompt_digest": manifest["prompt_digest"],
        "scorer_digest": manifest["scorer_digest"],
        "model_digest": manifest["model_digest"],
        "tool_policy_digest": manifest["tool_policy_digest"],
        "blind": manifest["blind"],
        "reviewer": manifest["reviewer"],
        "counts": scored["counts"],
        "metrics": scored["metrics"],
        "severity_confusion": scored["severity_confusion"],
        "case_results": scored["case_results"],
        "truth_outcomes": scored["truth_outcomes"],
    }
    write_json(args.output, report)
    return 0


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def command_aggregate(args: argparse.Namespace) -> int:
    reports = [load_json(path, f"score[{index}]") for index, path in enumerate(args.score)]
    if not reports:
        raise EvalError("at least one score report is required")
    compatibility_fields = (
        "corpus_version",
        "cases_digest",
        "diffmap_digest",
        "truth_digest",
        "taxonomy_digest",
        "skill_digest",
        "prompt_digest",
        "scorer_digest",
        "model_digest",
        "tool_policy_digest",
        "blind",
    )
    first = reports[0]
    first_reviewer = expect_object(first.get("reviewer"), "score[0].reviewer")
    for index, report in enumerate(reports):
        if report.get("status") != "valid":
            raise EvalError(f"score[{index}] is not valid")
        for field in compatibility_fields:
            if report.get(field) != first.get(field):
                raise EvalError(f"score reports differ on {field}")
        reviewer = expect_object(report.get("reviewer"), f"score[{index}].reviewer")
        if reviewer != first_reviewer:
            raise EvalError("score reports use different reviewer profiles")

    count_fields = ("material", "High", "Middle")
    pooled_counts: dict[str, Any] = {
        field: {"tp": 0, "fp": 0, "fn": 0} for field in count_fields
    }
    scalar_count_fields = (
        "strict_matches",
        "severity_correct",
        "semantic_localization_errors",
        "semantic_matches",
        "duplicate_false_positives",
        "attribution_false_positives",
        "negative_cases",
        "negative_cases_clean",
        "negative_false_positives",
        "cases_expected",
        "cases_returned",
        "cases_complete",
    )
    for field in scalar_count_fields:
        pooled_counts[field] = 0
    pooled_confusion = {
        "High": {"High": 0, "Middle": 0},
        "Middle": {"High": 0, "Middle": 0},
    }
    truth_misses: dict[str, dict[str, Any]] = {}
    for report in reports:
        counts = expect_object(report.get("counts"), "report.counts")
        for field in count_fields:
            for key in ("tp", "fp", "fn"):
                pooled_counts[field][key] += counts[field][key]
        for field in scalar_count_fields:
            pooled_counts[field] += counts[field]
        confusion = report["severity_confusion"]
        for expected in ("High", "Middle"):
            for predicted in ("High", "Middle"):
                pooled_confusion[expected][predicted] += confusion[expected][predicted]
        for outcome in report["truth_outcomes"]:
            entry = truth_misses.setdefault(
                outcome["truth_id"],
                {
                    "case_id": outcome["case_id"],
                    "severity": outcome["severity"],
                    "missed_runs": 0,
                    "severity_mismatch_runs": 0,
                },
            )
            if not outcome["detected"]:
                entry["missed_runs"] += 1
            elif not outcome["severity_correct"]:
                entry["severity_mismatch_runs"] += 1

    material = metric(**pooled_counts["material"])
    high = metric(**pooled_counts["High"])
    middle = metric(**pooled_counts["Middle"])
    strict_matches = pooled_counts["strict_matches"]
    semantic_matches = pooled_counts["semantic_matches"]
    expected_cases = pooled_counts["cases_expected"]
    pooled_metrics = {
        "material_precision": material["precision"],
        "material_recall": material["recall"],
        "material_f1": material["f1"],
        "high_precision": high["precision"],
        "high_recall": high["recall"],
        "high_f1": high["f1"],
        "middle_precision": middle["precision"],
        "middle_recall": middle["recall"],
        "middle_f1": middle["f1"],
        "severity_agreement": (
            pooled_counts["severity_correct"] / strict_matches if strict_matches else 0.0
        ),
        "severity_correct_recall": (
            pooled_counts["severity_correct"]
            / (pooled_counts["material"]["tp"] + pooled_counts["material"]["fn"])
            if pooled_counts["material"]["tp"] + pooled_counts["material"]["fn"]
            else 0.0
        ),
        "localization_accuracy": (
            strict_matches / semantic_matches if semantic_matches else 0.0
        ),
        "negative_case_accuracy": (
            pooled_counts["negative_cases_clean"] / pooled_counts["negative_cases"]
            if pooled_counts["negative_cases"]
            else 0.0
        ),
        "negative_fp_rate": (
            1.0
            - pooled_counts["negative_cases_clean"] / pooled_counts["negative_cases"]
            if pooled_counts["negative_cases"]
            else 0.0
        ),
        "negative_fp_per_pr": (
            pooled_counts["negative_false_positives"]
            / pooled_counts["negative_cases"]
            if pooled_counts["negative_cases"]
            else 0.0
        ),
        "false_positives_per_case": (
            pooled_counts["material"]["fp"] / expected_cases if expected_cases else 0.0
        ),
        "case_coverage": (
            pooled_counts["cases_complete"] / expected_cases if expected_cases else 0.0
        ),
        "case_record_coverage": (
            pooled_counts["cases_returned"] / expected_cases if expected_cases else 0.0
        ),
        "invalid_output_rate": 0.0,
    }
    macro: dict[str, Any] = {}
    for metric_name in pooled_metrics:
        values = [float(report["metrics"][metric_name]) for report in reports]
        macro[metric_name] = {
            "mean": mean(values),
            "stdev": statistics.pstdev(values) if len(values) > 1 else 0.0,
            "worst": (
                max(values)
                if metric_name in LOWER_IS_BETTER_METRICS
                else min(values)
            ),
        }

    aggregate = {
        "schema_version": SCHEMA_VERSION,
        "measurement_id": expect_string(args.measurement_id, "measurement_id"),
        "run_count": len(reports),
        "run_ids": [report["run_id"] for report in reports],
        "corpus_version": first["corpus_version"],
        "cases_digest": first["cases_digest"],
        "diffmap_digest": first["diffmap_digest"],
        "truth_digest": first["truth_digest"],
        "taxonomy_digest": first["taxonomy_digest"],
        "skill_digest": first["skill_digest"],
        "prompt_digest": first["prompt_digest"],
        "scorer_digest": first["scorer_digest"],
        "model_digest": first["model_digest"],
        "tool_policy_digest": first["tool_policy_digest"],
        "blind": first["blind"],
        "reviewer": first_reviewer,
        "counts": pooled_counts,
        "metrics": pooled_metrics,
        "macro": macro,
        "severity_confusion": pooled_confusion,
        "miss_rate_by_truth": {
            truth_id: {
                **details,
                "miss_rate": details["missed_runs"] / len(reports),
                "severity_mismatch_rate": details["severity_mismatch_runs"] / len(reports),
            }
            for truth_id, details in sorted(truth_misses.items())
        },
    }
    write_json(args.output, aggregate)
    return 0


def expect_numeric_map(value: Any, label: str) -> dict[str, float]:
    raw = expect_object(value, label)
    normalized: dict[str, float] = {}
    for key, item in raw.items():
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item):
            raise EvalError(f"{label}.{key} must be a finite number")
        normalized[key] = float(item)
    return normalized


def command_compare(args: argparse.Namespace) -> int:
    candidate = load_json(args.candidate, "candidate aggregate")
    baseline = load_json(args.baseline, "baseline aggregate")
    policy = load_json(args.policy, "policy")
    compatibility_fields = (
        "corpus_version",
        "cases_digest",
        "diffmap_digest",
        "truth_digest",
        "taxonomy_digest",
        "prompt_digest",
        "scorer_digest",
        "model_digest",
        "tool_policy_digest",
        "blind",
        "reviewer",
    )
    violations: list[str] = []
    for field in compatibility_fields:
        if candidate.get(field) != baseline.get(field):
            violations.append(f"incompatible baseline field: {field}")

    min_replicates = expect_int(policy.get("min_replicates"), "policy.min_replicates", minimum=1)
    if candidate.get("run_count", 0) < min_replicates:
        violations.append(
            f"run_count {candidate.get('run_count')} is below {min_replicates}"
        )
    if policy.get("require_blind") is True and candidate.get("blind") is not True:
        violations.append("candidate run is not verified blind")
    minimum_truth_support = expect_object(
        policy.get("minimum_truth_support", {}), "policy.minimum_truth_support"
    )
    for severity, minimum in minimum_truth_support.items():
        if severity not in MATERIAL_SEVERITIES:
            raise EvalError(f"unsupported minimum_truth_support severity: {severity}")
        minimum_count = expect_int(
            minimum, f"policy.minimum_truth_support.{severity}", minimum=1
        )
        candidate_counts = expect_object(candidate.get("counts"), "candidate.counts")
        severity_counts = expect_object(
            candidate_counts.get(severity), f"candidate.counts.{severity}"
        )
        support = severity_counts.get("tp", 0) + severity_counts.get("fn", 0)
        if support < minimum_count:
            violations.append(
                f"{severity} truth support {support} is below {minimum_count}"
            )
    candidate_metrics = expect_numeric_map(candidate.get("metrics"), "candidate.metrics")
    baseline_metrics = expect_numeric_map(baseline.get("metrics"), "baseline.metrics")
    absolute_min = expect_numeric_map(policy.get("absolute_min"), "policy.absolute_min")
    absolute_max = expect_numeric_map(policy.get("absolute_max"), "policy.absolute_max")
    max_drop = expect_numeric_map(policy.get("max_drop"), "policy.max_drop")
    max_increase = expect_numeric_map(policy.get("max_increase"), "policy.max_increase")

    for metric_name, threshold in absolute_min.items():
        value = candidate_metrics.get(metric_name)
        if value is None or value < threshold:
            violations.append(f"{metric_name}={value} is below floor {threshold}")
    for metric_name, threshold in absolute_max.items():
        value = candidate_metrics.get(metric_name)
        if value is None or value > threshold:
            violations.append(f"{metric_name}={value} exceeds maximum {threshold}")
    for metric_name, allowed_drop in max_drop.items():
        candidate_value = candidate_metrics.get(metric_name)
        baseline_value = baseline_metrics.get(metric_name)
        if candidate_value is None or baseline_value is None:
            violations.append(f"missing regression metric: {metric_name}")
        elif baseline_value - candidate_value > allowed_drop:
            violations.append(
                f"{metric_name} dropped {baseline_value - candidate_value:.6f} "
                f"(allowed {allowed_drop})"
            )
    for metric_name, allowed_increase in max_increase.items():
        candidate_value = candidate_metrics.get(metric_name)
        baseline_value = baseline_metrics.get(metric_name)
        if candidate_value is None or baseline_value is None:
            violations.append(f"missing regression metric: {metric_name}")
        elif candidate_value - baseline_value > allowed_increase:
            violations.append(
                f"{metric_name} increased {candidate_value - baseline_value:.6f} "
                f"(allowed {allowed_increase})"
            )

    if policy.get("require_zero_high_miss_runs") is True:
        for truth_id, details in candidate.get("miss_rate_by_truth", {}).items():
            if details.get("severity") == "High" and details.get("missed_runs", 0) > 0:
                violations.append(f"High truth missed: {truth_id}")

    result = {
        "schema_version": SCHEMA_VERSION,
        "status": "pass" if not violations else "fail",
        "candidate_measurement_id": candidate.get("measurement_id"),
        "baseline_measurement_id": baseline.get("measurement_id"),
        "candidate_skill_digest": candidate.get("skill_digest"),
        "baseline_skill_digest": baseline.get("skill_digest"),
        "deltas": {
            key: candidate_metrics[key] - baseline_metrics[key]
            for key in sorted(candidate_metrics.keys() & baseline_metrics.keys())
        },
        "violations": violations,
    }
    write_json(args.output, result)
    return 0 if not violations else 1


def command_record(args: argparse.Namespace) -> int:
    aggregate = load_json(args.aggregate, "aggregate")
    measurement_id = expect_string(aggregate.get("measurement_id"), "measurement_id")
    existing: list[dict[str, Any]] = []
    if args.history.exists():
        if args.history.is_symlink():
            raise EvalError("history must not be a symlink")
        for line_number, line in enumerate(
            args.history.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line.strip():
                continue
            try:
                existing.append(expect_object(json.loads(line), f"history line {line_number}"))
            except json.JSONDecodeError as error:
                raise EvalError(f"invalid history JSONL at line {line_number}") from error
    if any(item.get("measurement_id") == measurement_id for item in existing):
        raise EvalError(f"history already contains measurement_id: {measurement_id}")
    record = {
        "schema_version": SCHEMA_VERSION,
        "measurement_id": measurement_id,
        "aggregate_digest": digest_json(aggregate),
        "corpus_version": aggregate.get("corpus_version"),
        "skill_digest": aggregate.get("skill_digest"),
        "scorer_digest": aggregate.get("scorer_digest"),
        "reviewer": aggregate.get("reviewer"),
        "run_count": aggregate.get("run_count"),
        "metrics": aggregate.get("metrics"),
    }
    args.history.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(item, ensure_ascii=False, sort_keys=True) for item in existing]
    lines.append(json.dumps(record, ensure_ascii=False, sort_keys=True))
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=args.history.parent,
        prefix=f".{args.history.name}.",
        delete=False,
    ) as handle:
        handle.write("\n".join(lines) + "\n")
        temporary_path = Path(handle.name)
    temporary_path.replace(args.history)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    commands = {
        "validate": command_validate,
        "pack": command_pack,
        "run": command_run,
        "score": command_score,
        "aggregate": command_aggregate,
        "compare": command_compare,
        "record": command_record,
    }
    try:
        return commands[args.command](args)
    except (EvalError, OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
