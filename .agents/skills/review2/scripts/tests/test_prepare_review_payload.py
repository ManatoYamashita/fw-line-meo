from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "prepare_review_payload.py"
COMMIT_ID = "a" * 40
DIFFMAP = {
    "schema_version": 2,
    "head_sha": COMMIT_ID,
    "coverage": {"complete": True},
    "files": {
        "src/example.ts": {
            "patch_state": "complete",
            "sides": {
                "LEFT": {},
                "RIGHT": {
                    "42": {
                        "side": "RIGHT",
                        "old_line": None,
                        "new_line": 42,
                        "op": "add",
                        "is_changed": True,
                        "reviewable": True,
                        "hunk_index": 1,
                    }
                },
            },
        },
        "src/deleted.ts": {
            "patch_state": "complete",
            "sides": {
                "LEFT": {
                    str(line): {
                        "side": "LEFT",
                        "old_line": line,
                        "new_line": None,
                        "op": "delete",
                        "is_changed": True,
                        "reviewable": True,
                        "hunk_index": 2,
                    }
                    for line in range(10, 13)
                },
                "RIGHT": {},
            },
        },
    },
}

SPEC = importlib.util.spec_from_file_location("prepare_review_payload", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not load {SCRIPT_PATH}")
PAYLOAD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAYLOAD)


def finding(**overrides):
    result = {
        "path": "src/example.ts",
        "line": 42,
        "side": "RIGHT",
        "verdict": "KEEP",
        "severity": "Middle",
        "confidence": "high",
        "problem": (
            "同じ処理対象を同時に取得すると通知を二重送信し、"
            "利用者へ重複して届きます。"
        ),
        "fix": "取得と処理済み更新を同じ排他処理へ入れてください。",
    }
    result.update(overrides)
    return result


def prepare(source, **kwargs):
    return PAYLOAD.prepare_payload(source, DIFFMAP, **kwargs)


class PrepareReviewPayloadTests(unittest.TestCase):
    def test_selects_keep_findings_and_preserves_right_and_left_locations(self):
        source = {
            "event": "COMMENT",
            "commit_id": COMMIT_ID,
            "review_body": "High 1件、Middle 1件を確認しました。",
            "findings": [
                finding(severity="High"),
                finding(
                    path="src/deleted.ts",
                    start_line=10,
                    start_side="LEFT",
                    line=12,
                    side="LEFT",
                    confidence="medium",
                ),
                finding(severity="Low"),
                finding(severity="High", confidence="low"),
                finding(severity="High", confidence="medium", verdict="REVIEW"),
            ],
        }

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            payload = prepare(source)

        self.assertEqual(payload["event"], "COMMENT")
        self.assertEqual(payload["commit_id"], COMMIT_ID)
        self.assertEqual(len(payload["comments"]), 2)
        self.assertEqual(payload["comments"][0]["side"], "RIGHT")
        self.assertNotIn("start_line", payload["comments"][0])
        self.assertEqual(payload["comments"][1]["side"], "LEFT")
        self.assertEqual(payload["comments"][1]["start_line"], 10)
        self.assertEqual(payload["comments"][1]["start_side"], "LEFT")
        self.assertNotIn("confidence", payload["comments"][0]["body"])
        self.assertNotIn("verdict", payload["comments"][0]["body"])
        self.assertIn("severity=Low", stderr.getvalue())
        self.assertIn("confidence=low", stderr.getvalue())
        self.assertIn("verdict=REVIEW", stderr.getvalue())

    def test_non_keep_verdicts_are_excluded(self):
        for verdict in ("DOWNGRADE", "REJECT", "REVIEW"):
            with self.subTest(verdict=verdict):
                source = {
                    "commit_id": COMMIT_ID,
                    "review_body": "確定findingはありません。",
                    "findings": [finding(verdict=verdict, severity="High")],
                }
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    payload = prepare(source)

                self.assertNotIn("comments", payload)
                self.assertIn(f"verdict={verdict}", stderr.getvalue())

    def test_low_requires_explicit_extra_severity(self):
        source = {
            "commit_id": COMMIT_ID,
            "review_body": "Low findingを確認しました。",
            "findings": [finding(severity="Low")],
        }
        with contextlib.redirect_stderr(io.StringIO()):
            default_payload = prepare(source)
        self.assertNotIn("comments", default_payload)

        explicit_payload = prepare(source, extra_severities={"Low"})
        self.assertEqual(len(explicit_payload["comments"]), 1)
        self.assertTrue(explicit_payload["comments"][0]["body"].startswith("**[Low]**"))

    def test_verdict_is_required_and_validated(self):
        missing = finding()
        missing.pop("verdict")
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "verdict"):
            prepare(
                {
                    "commit_id": COMMIT_ID,
                    "review_body": "確認しました。",
                    "findings": [missing],
                }
            )

        with self.assertRaisesRegex(PAYLOAD.ValidationError, "KEEP"):
            prepare(
                {
                    "commit_id": COMMIT_ID,
                    "review_body": "確認しました。",
                    "findings": [finding(verdict="MAYBE")],
                }
            )

    def test_commit_id_is_required_and_validated(self):
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "commit_id"):
            prepare({"findings": [finding()]})

        with self.assertRaisesRegex(PAYLOAD.ValidationError, "40- or 64-character"):
            prepare(
                {"commit_id": "head", "findings": [finding()]}
            )

        sha256_diffmap = copy.deepcopy(DIFFMAP)
        sha256_diffmap["head_sha"] = "b" * 64
        payload = PAYLOAD.prepare_payload(
            {"commit_id": "b" * 64, "findings": [finding()]},
            sha256_diffmap,
        )
        self.assertEqual(payload["commit_id"], "b" * 64)

    def test_diffmap_snapshot_and_location_are_fail_closed(self):
        bad_head = copy.deepcopy(DIFFMAP)
        bad_head["head_sha"] = "c" * 40
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "head_sha"):
            PAYLOAD.prepare_payload(
                {"commit_id": COMMIT_ID, "findings": [finding()]}, bad_head
            )

        partial = copy.deepcopy(DIFFMAP)
        partial["files"]["src/example.ts"]["patch_state"] = "partial"
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "patch_state=complete"):
            PAYLOAD.prepare_payload(
                {"commit_id": COMMIT_ID, "findings": [finding()]}, partial
            )

        context_anchor = copy.deepcopy(DIFFMAP)
        context_anchor["files"]["src/example.ts"]["sides"]["RIGHT"]["42"][
            "is_changed"
        ] = False
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "changed diff line"):
            PAYLOAD.prepare_payload(
                {"commit_id": COMMIT_ID, "findings": [finding()]}, context_anchor
            )

        cross_hunk = copy.deepcopy(DIFFMAP)
        cross_hunk["files"]["src/deleted.ts"]["sides"]["LEFT"]["10"][
            "hunk_index"
        ] = 1
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "one hunk"):
            PAYLOAD.prepare_payload(
                {
                    "commit_id": COMMIT_ID,
                    "findings": [
                        finding(
                            path="src/deleted.ts",
                            start_line=10,
                            start_side="LEFT",
                            line=12,
                            side="LEFT",
                        )
                    ],
                },
                cross_hunk,
            )

    def test_rejects_invalid_comment_content_and_location(self):
        cases = {
            "vague": (
                {"problem": "この変更には問題があります。"},
                "vague wording",
            ),
            "question": (
                {"problem": "null入力で処理が停止しませんか？"},
                "must not be a question",
            ),
            "newline": (
                {"problem": "null入力で処理が停止し、\n結果を返せません。"},
                "must be one line",
            ),
            "multiple sentences": (
                {"problem": "null入力で処理が停止します。結果を返せません。"},
                "exactly one sentence",
            ),
            "generic fix": (
                {"fix": "修正してください。"},
                "minimum corrective condition",
            ),
            "invalid side": ({"side": "CENTER"}, "LEFT or RIGHT"),
            "too long": (
                {
                    "problem": (
                        "入力時に"
                        + "処理結果を確定できない状態が継続し" * 15
                        + "失敗します。"
                    )
                },
                "exceeds 240 characters",
            ),
        }

        for name, (overrides, expected) in cases.items():
            with self.subTest(name=name):
                source = {
                    "commit_id": COMMIT_ID,
                    "findings": [finding(**overrides)],
                }
                with self.assertRaisesRegex(PAYLOAD.ValidationError, expected):
                    prepare(source)

    def test_decision_events_require_explicit_flag(self):
        source = {
            "event": "APPROVE",
            "commit_id": COMMIT_ID,
            "review_body": "検証済みです。",
            "merge_decision": "lgtm",
            "required_checks": "passed",
            "intent_status": "satisfied",
            "findings": [],
        }
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "allow-decision-event"):
            prepare(source)

        payload = prepare(source, allow_decision_event=True)
        self.assertEqual(payload["event"], "APPROVE")

        no_required_checks = {**source, "required_checks": "not-applicable"}
        payload = prepare(no_required_checks, allow_decision_event=True)
        self.assertEqual(payload["event"], "APPROVE")

        contradictory = {**source, "findings": [finding(severity="High")]}
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "empty findings"):
            prepare(contradictory, allow_decision_event=True)

        request_without_comment = {
            "event": "REQUEST_CHANGES",
            "commit_id": COMMIT_ID,
            "review_body": "修正が必要です。",
            "merge_decision": "block",
            "findings": [],
        }
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "High or Middle"):
            prepare(request_without_comment, allow_decision_event=True)

        request_with_low = {
            **request_without_comment,
            "findings": [finding(severity="Low")],
        }
        with self.assertRaisesRegex(PAYLOAD.ValidationError, "High or Middle"):
            prepare(
                request_with_low,
                allow_decision_event=True,
                extra_severities={"Low"},
            )

        request_with_comment = {
            **request_without_comment,
            "findings": [finding(severity="High")],
        }
        payload = prepare(request_with_comment, allow_decision_event=True)
        self.assertEqual(payload["event"], "REQUEST_CHANGES")

    def test_cli_writes_filtered_github_payload(self):
        source = {
            "event": "COMMENT",
            "commit_id": COMMIT_ID,
            "review_body": "Middle 1件を確認しました。",
            "findings": [finding(), finding(verdict="REVIEW", severity="High")],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "findings.json"
            diffmap_path = Path(temp_dir) / "diffmap.json"
            output_path = Path(temp_dir) / "payload.json"
            input_path.write_text(
                json.dumps(source, ensure_ascii=False), encoding="utf-8"
            )
            diffmap_path.write_text(
                json.dumps(DIFFMAP, ensure_ascii=False), encoding="utf-8"
            )
            env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--input",
                    str(input_path),
                    "--diffmap",
                    str(diffmap_path),
                    "--output",
                    str(output_path),
                ],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["event"], "COMMENT")
            self.assertEqual(payload["commit_id"], COMMIT_ID)
            self.assertEqual(len(payload["comments"]), 1)
            self.assertTrue(payload["comments"][0]["body"].startswith("**[Middle]**"))
            self.assertIn("verdict=REVIEW", completed.stderr)


if __name__ == "__main__":
    unittest.main()
