#!/usr/bin/env python3
"""構造化findingを検証し、GitHub review payloadへ変換します。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ALLOWED_EVENTS = {"COMMENT", "APPROVE", "REQUEST_CHANGES"}
ALLOWED_SEVERITIES = {"High", "Middle", "Low", "Nit"}
ALLOWED_CONFIDENCES = {"high", "medium", "low"}
ALLOWED_VERDICTS = {"KEEP", "DOWNGRADE", "REJECT", "REVIEW"}
DEFAULT_SEVERITIES = {"High", "Middle"}
DEFAULT_CONFIDENCES = {"high", "medium"}
ALLOWED_SIDES = {"LEFT", "RIGHT"}
ALLOWED_MERGE_DECISIONS = {"lgtm", "conditional", "block"}
ALLOWED_CHECK_STATES = {
    "passed",
    "failed",
    "inconclusive",
    "not-run",
    "not-applicable",
}
ALLOWED_INTENT_STATES = {"satisfied", "partial", "deviated", "unknown"}
RECOMMENDED_MIN = 60
RECOMMENDED_MAX = 180
HARD_MAX = 240

VAGUE_PATTERNS = (
    (
        re.compile(r"問題(?:が)?あります"),
        "具体的な不具合と影響を書いてください",
    ),
    (
        re.compile(r"危険です"),
        "具体的な攻撃経路または影響を書いてください",
    ),
    (
        re.compile(r"可能性(?:が)?あります"),
        "成立条件と起きる結果を断定可能な形で書いてください",
    ),
    (
        re.compile(r"かもしれません"),
        "成立条件と起きる結果を断定可能な形で書いてください",
    ),
    (
        re.compile(r"懸念(?:が)?あります"),
        "具体的な不具合と影響を書いてください",
    ),
    (re.compile(r"気になります"), "具体的な不具合と影響を書いてください"),
    (re.compile(r"念のため"), "再現条件または必要性を具体化してください"),
    (re.compile(r"適切に"), "満たすべき修正条件を具体化してください"),
    (
        re.compile(r"ベストプラクティス"),
        "この変更で起きる具体的な失敗を書いてください",
    ),
    (
        re.compile(r"\b(?:maybe|might|potentially)\b", re.IGNORECASE),
        "state a concrete precondition and outcome",
    ),
    (
        re.compile(
            r"\bcould be (?:a |an )?(?:problem|issue)\b", re.IGNORECASE
        ),
        "state the concrete failure",
    ),
)

PERSON_PATTERNS = (
    re.compile(r"あなた"),
    re.compile(r"きみ"),
    re.compile(r"君"),
    re.compile(r"作者"),
    re.compile(r"実装者"),
    re.compile(r"開発者"),
    re.compile(r"なぜ(?:この|こんな|その)"),
    re.compile(r"\b(?:you|author|developer)\b", re.IGNORECASE),
)

GENERIC_FIX = re.compile(
    r"^(?:(?:適切に)?(?:修正|対応|検討|見直し)(?:を)?してください|"
    r"(?:please\s+)?(?:fix|address|consider|review)(?:\s+this)?)[。.]*$",
    re.IGNORECASE,
)
BLOCK_MARKUP = re.compile(r"^\s*(?:#{1,6}\s|[-+*]\s|>\s|\d+[.)]\s)|```|\|.*\|")
INLINE_CODE = re.compile(r"`[^`\n]*`")
MARKDOWN_LINK = re.compile(r"\[[^\]\n]+\]\([^\s)]+\)")
ASCII_TERMINATOR = re.compile(r"[.!](?=\s|$)")
COMMIT_ID = re.compile(r"[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?")


class ValidationError(ValueError):
    """入力findingまたはreview設定が不正な場合に送出します。"""


def _expect_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{label} must be a JSON object")
    return value


def _expect_string(value: Any, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{label} must be a string")
    if value != value.strip():
        raise ValidationError(f"{label} must not have leading or trailing whitespace")
    if not allow_empty and not value:
        raise ValidationError(f"{label} must not be empty")
    return value


def _expect_positive_int(value: Any, label: str) -> int:
    if type(value) is not int or value < 1:
        raise ValidationError(f"{label} must be a positive integer")
    return value


def _mask_non_prose(text: str) -> str:
    masked = INLINE_CODE.sub("CODE", text)
    return MARKDOWN_LINK.sub("LINK", masked)


def _validate_sentence(text: Any, label: str, *, is_fix: bool = False) -> str:
    sentence = _expect_string(text, label)

    if "\n" in sentence or "\r" in sentence:
        raise ValidationError(f"{label} must be one line")
    if "?" in sentence or "？" in sentence:
        raise ValidationError(f"{label} must not be a question")
    if "!" in sentence or "！" in sentence:
        raise ValidationError(f"{label} must not contain an exclamation mark")
    masked = _mask_non_prose(sentence)
    if BLOCK_MARKUP.search(masked):
        raise ValidationError(f"{label} must not contain headings, lists, tables, or code fences")

    for pattern, guidance in VAGUE_PATTERNS:
        if pattern.search(masked):
            raise ValidationError(f"{label} contains vague wording: {pattern.pattern}; {guidance}")
    for pattern in PERSON_PATTERNS:
        if pattern.search(masked):
            raise ValidationError(f"{label} must discuss code, not a person: {pattern.pattern}")

    if is_fix and GENERIC_FIX.fullmatch(sentence):
        raise ValidationError(f"{label} must state the minimum corrective condition")

    if not (masked.endswith("。") or masked.endswith(".")):
        raise ValidationError(f"{label} must end with one sentence terminator ('。' or '.')")

    stem = masked[:-1]
    if "。" in stem or ASCII_TERMINATOR.search(stem):
        raise ValidationError(f"{label} must contain exactly one sentence")

    return sentence


def _validate_path(value: Any, label: str) -> str:
    path = _expect_string(value, label)
    if "\n" in path or "\r" in path:
        raise ValidationError(f"{label} must be one line")
    if path.startswith("/") or any(part == ".." for part in Path(path).parts):
        raise ValidationError(f"{label} must be a repository-relative path")
    return path


def _validate_side(value: Any, label: str) -> str:
    side = _expect_string(value, label)
    if side not in ALLOWED_SIDES:
        raise ValidationError(f"{label} must be LEFT or RIGHT")
    return side


def _validate_commit_id(value: Any) -> str:
    commit_id = _expect_string(value, "commit_id")
    if not COMMIT_ID.fullmatch(commit_id):
        raise ValidationError("commit_id must be a 40- or 64-character Git object ID")
    return commit_id


def _optional_enum(
    source: dict[str, Any], key: str, allowed: set[str]
) -> str | None:
    value = source.get(key)
    if value is None:
        return None
    normalized = _expect_string(value, key)
    if normalized not in allowed:
        raise ValidationError(f"{key} must be one of {sorted(allowed)}")
    return normalized


def _validate_diffmap(diffmap: Any, commit_id: str) -> dict[str, Any]:
    normalized = _expect_object(diffmap, "diffmap")
    if normalized.get("schema_version") != 2:
        raise ValidationError("diffmap.schema_version must be 2")
    if normalized.get("head_sha") != commit_id:
        raise ValidationError("diffmap.head_sha must match commit_id")
    if not isinstance(normalized.get("files"), dict):
        raise ValidationError("diffmap.files must be a JSON object")
    if not isinstance(normalized.get("coverage"), dict):
        raise ValidationError("diffmap.coverage must be a JSON object")
    return normalized


def _diff_line(
    diffmap: dict[str, Any],
    *,
    path: str,
    side: str,
    line: int,
    label: str,
) -> dict[str, Any]:
    files = diffmap["files"]
    file_entry = files.get(path)
    if not isinstance(file_entry, dict):
        raise ValidationError(f"{label} path is not present in diffmap")
    if file_entry.get("patch_state") != "complete":
        raise ValidationError(f"{label} requires patch_state=complete")
    sides = file_entry.get("sides")
    if not isinstance(sides, dict) or not isinstance(sides.get(side), dict):
        raise ValidationError(f"{label} side is not present in diffmap")
    entry = sides[side].get(str(line))
    if not isinstance(entry, dict):
        raise ValidationError(f"{label} line is not present on diffmap side {side}")
    if entry.get("side") != side or entry.get("reviewable") is not True:
        raise ValidationError(f"{label} line is not reviewable on side {side}")
    expected_line = entry.get("old_line" if side == "LEFT" else "new_line")
    if expected_line != line:
        raise ValidationError(f"{label} line metadata does not match side {side}")
    if type(entry.get("hunk_index")) is not int or entry["hunk_index"] < 1:
        raise ValidationError(f"{label} line has no valid hunk_index")
    return entry


def _validate_location(
    diffmap: dict[str, Any],
    *,
    path: str,
    side: str,
    line: int,
    start_line: int | None,
    label: str,
) -> None:
    end_entry = _diff_line(
        diffmap, path=path, side=side, line=line, label=f"{label}.line"
    )
    if end_entry.get("is_changed") is not True:
        raise ValidationError(f"{label}.line must anchor to a changed diff line")
    if start_line is None or start_line == line:
        return

    hunk_index = end_entry["hunk_index"]
    for current_line in range(start_line, line + 1):
        entry = _diff_line(
            diffmap,
            path=path,
            side=side,
            line=current_line,
            label=f"{label}.start_line",
        )
        if entry["hunk_index"] != hunk_index:
            raise ValidationError(f"{label} multiline comment must stay in one hunk")


def _render_comment(
    finding: dict[str, Any],
    index: int,
    selected_severities: set[str],
    diffmap: dict[str, Any],
) -> dict[str, Any] | None:
    label = f"findings[{index}]"
    verdict = _expect_string(finding.get("verdict"), f"{label}.verdict")
    severity = _expect_string(finding.get("severity"), f"{label}.severity")
    confidence = _expect_string(finding.get("confidence"), f"{label}.confidence")

    if verdict not in ALLOWED_VERDICTS:
        raise ValidationError(
            f"{label}.verdict must be one of {sorted(ALLOWED_VERDICTS)}"
        )
    if severity not in ALLOWED_SEVERITIES:
        raise ValidationError(
            f"{label}.severity must be one of {sorted(ALLOWED_SEVERITIES)}"
        )
    if confidence not in ALLOWED_CONFIDENCES:
        raise ValidationError(
            f"{label}.confidence must be one of {sorted(ALLOWED_CONFIDENCES)}"
        )

    if (
        verdict != "KEEP"
        or severity not in selected_severities
        or confidence not in DEFAULT_CONFIDENCES
    ):
        print(
            f"excluded {label}: verdict={verdict}, severity={severity}, "
            f"confidence={confidence}",
            file=sys.stderr,
        )
        return None

    problem = _validate_sentence(finding.get("problem"), f"{label}.problem")
    fix = _validate_sentence(finding.get("fix"), f"{label}.fix", is_fix=True)
    separator = " " if problem.endswith(".") else ""
    body = f"**[{severity}]** {problem}{separator}{fix}"

    if len(body) > HARD_MAX:
        raise ValidationError(f"{label} rendered body exceeds {HARD_MAX} characters")
    if len(body) < RECOMMENDED_MIN or len(body) > RECOMMENDED_MAX:
        print(
            f"warning {label}: rendered body has {len(body)} characters "
            f"(recommended {RECOMMENDED_MIN}-{RECOMMENDED_MAX})",
            file=sys.stderr,
        )

    path = _validate_path(finding.get("path"), f"{label}.path")
    line = _expect_positive_int(finding.get("line"), f"{label}.line")
    side = _validate_side(finding.get("side"), f"{label}.side")

    comment: dict[str, Any] = {
        "path": path,
        "line": line,
        "side": side,
        "body": body,
    }

    has_start_line = finding.get("start_line") is not None
    has_start_side = finding.get("start_side") is not None
    if has_start_side and not has_start_line:
        raise ValidationError(f"{label}.start_side requires start_line")
    if has_start_line:
        start_line = _expect_positive_int(
            finding.get("start_line"), f"{label}.start_line"
        )
        start_side = (
            _validate_side(finding.get("start_side"), f"{label}.start_side")
            if has_start_side
            else side
        )
        if start_side != side:
            raise ValidationError(f"{label} multiline comment cannot cross LEFT/RIGHT sides")
        if start_line > line:
            raise ValidationError(f"{label}.start_line must not exceed line")
        if start_line < line:
            comment["start_line"] = start_line
            comment["start_side"] = start_side

    _validate_location(
        diffmap,
        path=path,
        side=side,
        line=line,
        start_line=comment.get("start_line"),
        label=label,
    )

    return comment


def prepare_payload(
    data: Any,
    diffmap: Any,
    *,
    allow_decision_event: bool = False,
    extra_severities: set[str] | None = None,
) -> dict[str, Any]:
    source = _expect_object(data, "input")
    requested_extra = set() if extra_severities is None else set(extra_severities)
    unsupported_extra = requested_extra - {"Low", "Nit"}
    if unsupported_extra:
        raise ValidationError(
            f"extra_severities may contain only Low or Nit: {sorted(unsupported_extra)}"
        )
    selected_severities = DEFAULT_SEVERITIES | requested_extra
    commit_id = _validate_commit_id(source.get("commit_id"))
    normalized_diffmap = _validate_diffmap(diffmap, commit_id)
    event = _expect_string(source.get("event", "COMMENT"), "event")
    if event not in ALLOWED_EVENTS:
        raise ValidationError(f"event must be one of {sorted(ALLOWED_EVENTS)}")
    if event != "COMMENT" and not allow_decision_event:
        raise ValidationError(
            "APPROVE and REQUEST_CHANGES require --allow-decision-event"
        )

    findings = source.get("findings")
    if not isinstance(findings, list):
        raise ValidationError("findings must be a JSON array")

    comments: list[dict[str, Any]] = []
    for index, raw_finding in enumerate(findings):
        finding = _expect_object(raw_finding, f"findings[{index}]")
        rendered = _render_comment(
            finding, index, selected_severities, normalized_diffmap
        )
        if rendered is not None:
            comments.append(rendered)

    merge_decision = _optional_enum(
        source, "merge_decision", ALLOWED_MERGE_DECISIONS
    )
    required_checks = _optional_enum(
        source, "required_checks", ALLOWED_CHECK_STATES
    )
    intent_status = _optional_enum(
        source, "intent_status", ALLOWED_INTENT_STATES
    )

    if event == "APPROVE":
        coverage = normalized_diffmap["coverage"]
        if findings:
            raise ValidationError("APPROVE requires an empty findings array")
        if comments:
            raise ValidationError("APPROVE cannot contain inline comments")
        if coverage.get("complete") is not True:
            raise ValidationError("APPROVE requires diffmap.coverage.complete=true")
        if merge_decision != "lgtm":
            raise ValidationError("APPROVE requires merge_decision=lgtm")
        if required_checks not in {"passed", "not-applicable"}:
            raise ValidationError(
                "APPROVE requires required_checks=passed or not-applicable"
            )
        if intent_status != "satisfied":
            raise ValidationError("APPROVE requires intent_status=satisfied")
    elif event == "REQUEST_CHANGES":
        if merge_decision != "block":
            raise ValidationError("REQUEST_CHANGES requires merge_decision=block")
        if not any(
            comment["body"].startswith(("**[High]**", "**[Middle]**"))
            for comment in comments
        ):
            raise ValidationError(
                "REQUEST_CHANGES requires an actionable High or Middle inline comment"
            )

    payload: dict[str, Any] = {"event": event, "commit_id": commit_id}
    review_body = source.get("review_body")
    if review_body is not None:
        payload["body"] = _expect_string(review_body, "review_body")
    if comments:
        payload["comments"] = comments
    if "body" not in payload and "comments" not in payload:
        raise ValidationError("payload must contain review_body or at least one selected finding")
    return payload


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare a validated GitHub pull request review payload."
    )
    parser.add_argument("--input", required=True, type=Path, help="structured findings JSON")
    parser.add_argument(
        "--diffmap",
        required=True,
        type=Path,
        help="schema v2 diffmap used to validate every comment location",
    )
    parser.add_argument("--output", type=Path, help="output payload JSON; stdout if omitted")
    parser.add_argument(
        "--allow-decision-event",
        action="store_true",
        help="allow APPROVE or REQUEST_CHANGES after explicit user authorization",
    )
    parser.add_argument(
        "--include-severity",
        action="append",
        choices=("Low", "Nit"),
        default=[],
        help="include an explicitly authorized Low or Nit severity; may be repeated",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        with args.input.open(encoding="utf-8") as handle:
            data = json.load(handle)
        with args.diffmap.open(encoding="utf-8") as handle:
            diffmap = json.load(handle)
        payload = prepare_payload(
            data,
            diffmap,
            allow_decision_event=args.allow_decision_event,
            extra_severities=set(args.include_severity),
        )
    except (OSError, json.JSONDecodeError, ValidationError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    rendered = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
