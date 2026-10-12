#!/usr/bin/env python3
"""Build a deterministic, coverage-aware diff map from GitHub PR files JSON."""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 2
GITHUB_FILES_API_LIMIT = 3000
HUNK_RE = re.compile(
    r"^@@ -(?P<old>\d+)(?:,(?P<old_count>\d+))? "
    r"\+(?P<new>\d+)(?:,(?P<new_count>\d+))? @@"
)


def nonnegative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Convert JSON from `gh api --paginate --slurp .../pulls/PR/files` "
            "into a two-sided diff map with explicit coverage state."
        )
    )
    parser.add_argument("--input", required=True, type=Path, help="GitHub files JSON")
    parser.add_argument("--base-sha", required=True, help="Immutable PR base ref SHA")
    parser.add_argument(
        "--merge-base-sha",
        required=True,
        help="Merge-base SHA used by the PR three-dot diff",
    )
    parser.add_argument("--head-sha", required=True, help="Immutable PR head commit SHA")
    parser.add_argument(
        "--expected-file-count",
        required=True,
        type=nonnegative_int,
        help="PR changedFiles value used to verify pagination completeness",
    )
    parser.add_argument("--output", required=True, type=Path, help="Output JSON")
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="GLOB",
        help="Repository-relative path glob to exclude; may be repeated",
    )
    return parser.parse_args()


def flatten_pages(raw: Any) -> list[dict[str, Any]]:
    """Accept a files array, a slurped array of pages, or one file object."""
    if isinstance(raw, dict):
        return [raw]
    if not isinstance(raw, list):
        raise ValueError("input must be a JSON object or array")
    if not raw:
        return []
    if all(isinstance(item, dict) for item in raw):
        return raw

    files: list[dict[str, Any]] = []
    for page_index, page in enumerate(raw):
        if not isinstance(page, list) or not all(
            isinstance(item, dict) for item in page
        ):
            raise ValueError(f"page {page_index} is not an array of file objects")
        files.extend(page)
    return files


def excluded(path: str, patterns: list[str]) -> str | None:
    for pattern in patterns:
        if fnmatch.fnmatchcase(path, pattern):
            return pattern
    return None


def require_nonnegative_file_count(file_info: dict[str, Any], key: str) -> int:
    value = file_info.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        path = file_info.get("filename", "<unknown>")
        raise ValueError(f"{path}: {key} must be a non-negative integer")
    return value


def add_line(
    side_lines: dict[str, dict[str, dict[str, Any]]],
    *,
    side: str,
    line_number: int,
    text: str,
    old_line: int | None,
    new_line: int | None,
    op: str,
    is_changed: bool,
    hunk_index: int,
) -> None:
    key = str(line_number)
    if key in side_lines[side]:
        raise ValueError(f"duplicate {side} line in patch: {line_number}")
    side_lines[side][key] = {
        "text": text,
        "side": side,
        "old_line": old_line,
        "new_line": new_line,
        "op": op,
        "is_changed": is_changed,
        "reviewable": True,
        "hunk_index": hunk_index,
    }


def parse_patch(
    patch: str,
) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, int]]:
    """Parse deleted lines on LEFT and added/context lines on RIGHT."""
    side_lines: dict[str, dict[str, dict[str, Any]]] = {
        "LEFT": {},
        "RIGHT": {},
    }
    old_line: int | None = None
    new_line: int | None = None
    hunks = 0
    added = 0
    context = 0
    deleted = 0
    unparsed_hunk_lines = 0
    incomplete_hunks = 0
    expected_old = 0
    expected_new = 0
    seen_old = 0
    seen_new = 0

    def finish_hunk() -> None:
        nonlocal incomplete_hunks
        if old_line is None or new_line is None:
            return
        if seen_old != expected_old or seen_new != expected_new:
            incomplete_hunks += 1

    for raw_line in patch.splitlines():
        line = raw_line[:-1] if raw_line.endswith("\r") else raw_line
        hunk = HUNK_RE.match(line)
        if hunk:
            finish_hunk()
            old_line = int(hunk.group("old"))
            new_line = int(hunk.group("new"))
            expected_old = int(hunk.group("old_count") or "1")
            expected_new = int(hunk.group("new_count") or "1")
            seen_old = 0
            seen_new = 0
            hunks += 1
            continue

        if old_line is None or new_line is None:
            continue
        if line.startswith("\\"):
            continue
        if line.startswith("+"):
            add_line(
                side_lines,
                side="RIGHT",
                line_number=new_line,
                text=line[1:],
                old_line=None,
                new_line=new_line,
                op="add",
                is_changed=True,
                hunk_index=hunks,
            )
            new_line += 1
            seen_new += 1
            added += 1
            continue
        if line.startswith("-"):
            add_line(
                side_lines,
                side="LEFT",
                line_number=old_line,
                text=line[1:],
                old_line=old_line,
                new_line=None,
                op="delete",
                is_changed=True,
                hunk_index=hunks,
            )
            old_line += 1
            seen_old += 1
            deleted += 1
            continue
        if line.startswith(" "):
            add_line(
                side_lines,
                side="RIGHT",
                line_number=new_line,
                text=line[1:],
                old_line=old_line,
                new_line=new_line,
                op="context",
                is_changed=False,
                hunk_index=hunks,
            )
            old_line += 1
            new_line += 1
            seen_old += 1
            seen_new += 1
            context += 1
            continue

        unparsed_hunk_lines += 1

    finish_hunk()

    return side_lines, {
        "hunks": hunks,
        "parsed_additions": added,
        "parsed_context_lines": context,
        "parsed_deletions": deleted,
        "unparsed_hunk_lines": unparsed_hunk_lines,
        "incomplete_hunks": incomplete_hunks,
    }


def validate_snapshot(
    base_sha: str,
    merge_base_sha: str,
    head_sha: str,
    expected_file_count: int,
) -> None:
    if not isinstance(base_sha, str) or not base_sha.strip():
        raise ValueError("base_sha must be a non-empty string")
    if not isinstance(head_sha, str) or not head_sha.strip():
        raise ValueError("head_sha must be a non-empty string")
    if not isinstance(merge_base_sha, str) or not merge_base_sha.strip():
        raise ValueError("merge_base_sha must be a non-empty string")
    if (
        not isinstance(expected_file_count, int)
        or isinstance(expected_file_count, bool)
        or expected_file_count < 0
    ):
        raise ValueError("expected_file_count must be a non-negative integer")


def build_diffmap(
    files: list[dict[str, Any]],
    base_sha: str,
    merge_base_sha: str,
    head_sha: str,
    expected_file_count: int,
    patterns: list[str],
) -> dict[str, Any]:
    validate_snapshot(base_sha, merge_base_sha, head_sha, expected_file_count)

    output_files: dict[str, Any] = {}
    complete_files: list[str] = []
    partial_files: list[dict[str, Any]] = []
    excluded_files: list[dict[str, str]] = []
    missing_patch: list[dict[str, Any]] = []

    for file_info in files:
        path = file_info.get("filename")
        if not isinstance(path, str) or not path:
            raise ValueError("every file object must have a non-empty filename")
        if path in output_files:
            raise ValueError(f"duplicate filename in paginated input: {path}")

        additions = require_nonnegative_file_count(file_info, "additions")
        deletions = require_nonnegative_file_count(file_info, "deletions")
        matched_pattern = excluded(path, patterns)
        common = {
            "status": file_info.get("status"),
            "previous_filename": file_info.get("previous_filename"),
            "blob_sha": file_info.get("sha"),
            "additions": additions,
            "deletions": deletions,
            "changes": file_info.get("changes"),
        }
        empty_sides: dict[str, dict[str, Any]] = {"LEFT": {}, "RIGHT": {}}

        if matched_pattern:
            output_files[path] = {
                **common,
                "patch_state": "excluded",
                "exclude_pattern": matched_pattern,
                "sides": empty_sides,
            }
            excluded_files.append({"path": path, "pattern": matched_pattern})
            continue

        patch = file_info.get("patch")
        if not isinstance(patch, str):
            output_files[path] = {
                **common,
                "patch_state": "missing",
                "sides": empty_sides,
            }
            missing_patch.append(
                {
                    "path": path,
                    "status": file_info.get("status"),
                    "changes": file_info.get("changes"),
                }
            )
            continue

        sides, stats = parse_patch(patch)
        count_match = (
            stats["parsed_additions"] == additions
            and stats["parsed_deletions"] == deletions
        )
        syntax_complete = stats["unparsed_hunk_lines"] == 0
        hunks_complete = stats["incomplete_hunks"] == 0
        integrity_complete = count_match and syntax_complete and hunks_complete
        patch_state = "complete" if integrity_complete else "partial"
        integrity = {
            "count_match": count_match,
            "syntax_complete": syntax_complete,
            "hunks_complete": hunks_complete,
            "complete": integrity_complete,
            "expected_additions": additions,
            "parsed_additions": stats["parsed_additions"],
            "expected_deletions": deletions,
            "parsed_deletions": stats["parsed_deletions"],
            "unparsed_hunk_lines": stats["unparsed_hunk_lines"],
            "incomplete_hunks": stats["incomplete_hunks"],
        }
        output_files[path] = {
            **common,
            "patch_state": patch_state,
            "sides": sides,
            "parse_stats": stats,
            "patch_integrity": integrity,
        }

        if integrity_complete:
            complete_files.append(path)
        else:
            partial_files.append({"path": path, **integrity})

    fetched_file_count = len(files)
    file_count_match = fetched_file_count == expected_file_count
    api_file_limit_candidate = expected_file_count > GITHUB_FILES_API_LIMIT or (
        fetched_file_count == GITHUB_FILES_API_LIMIT and not file_count_match
    )
    coverage_complete = (
        file_count_match
        and not api_file_limit_candidate
        and not partial_files
        and not missing_patch
        and not excluded_files
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "base_sha": base_sha,
        "merge_base_sha": merge_base_sha,
        "head_sha": head_sha,
        "expected_file_count": expected_file_count,
        "files": output_files,
        "coverage": {
            "complete": coverage_complete,
            "expected_file_count": expected_file_count,
            "fetched_file_count": fetched_file_count,
            "file_count_match": file_count_match,
            "api_file_limit": GITHUB_FILES_API_LIMIT,
            "api_file_limit_candidate": api_file_limit_candidate,
            "complete_files": complete_files,
            "partial_files": partial_files,
            "missing_patch": missing_patch,
            "excluded_files": excluded_files,
        },
    }


def main() -> int:
    args = parse_args()
    raw = json.loads(args.input.read_text(encoding="utf-8"))
    files = flatten_pages(raw)
    diffmap = build_diffmap(
        files,
        base_sha=args.base_sha,
        merge_base_sha=args.merge_base_sha,
        head_sha=args.head_sha,
        expected_file_count=args.expected_file_count,
        patterns=args.exclude,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(diffmap, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
