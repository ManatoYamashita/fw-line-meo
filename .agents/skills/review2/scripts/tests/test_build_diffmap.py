from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "build_diffmap.py"
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
BASE_SHA = "base-0123456789"
MERGE_BASE_SHA = "merge-base-0123456789"
HEAD_SHA = "head-0123456789"

SPEC = importlib.util.spec_from_file_location("build_diffmap", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not load {SCRIPT_PATH}")
DIFFMAP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIFFMAP)


class BuildDiffmapTests(unittest.TestCase):
    def load_files(self, fixture_name: str):
        raw = json.loads((FIXTURE_DIR / fixture_name).read_text(encoding="utf-8"))
        return DIFFMAP.flatten_pages(raw)

    def build(self, fixture_name: str, expected_file_count: int, patterns=None):
        return DIFFMAP.build_diffmap(
            self.load_files(fixture_name),
            base_sha=BASE_SHA,
            merge_base_sha=MERGE_BASE_SHA,
            head_sha=HEAD_SHA,
            expected_file_count=expected_file_count,
            patterns=[] if patterns is None else patterns,
        )

    def test_guard_deletion_is_preserved_on_left(self):
        result = self.build("guard_deletion.json", expected_file_count=1)

        self.assertEqual(result["schema_version"], 2)
        self.assertEqual(result["base_sha"], BASE_SHA)
        self.assertEqual(result["merge_base_sha"], MERGE_BASE_SHA)
        self.assertEqual(result["head_sha"], HEAD_SHA)
        self.assertEqual(result["expected_file_count"], 1)
        entry = result["files"]["src/auth.ts"]
        self.assertEqual(entry["patch_state"], "complete")
        self.assertEqual(
            entry["sides"]["LEFT"]["11"],
            {
                "text": "  authorize(user)",
                "side": "LEFT",
                "old_line": 11,
                "new_line": None,
                "op": "delete",
                "is_changed": True,
                "reviewable": True,
                "hunk_index": 1,
            },
        )
        self.assertEqual(entry["sides"]["RIGHT"]["10"]["op"], "context")
        self.assertEqual(entry["sides"]["RIGHT"]["11"]["op"], "context")
        self.assertEqual(entry["sides"]["RIGHT"]["11"]["text"], "  mutate()")
        self.assertTrue(result["coverage"]["complete"])

    def test_replacement_keeps_both_changed_sides(self):
        result = self.build("replacement.json", expected_file_count=1)
        entry = result["files"]["src/transform.ts"]

        self.assertEqual(entry["sides"]["LEFT"]["5"]["op"], "delete")
        self.assertEqual(entry["sides"]["LEFT"]["5"]["new_line"], None)
        self.assertEqual(entry["sides"]["RIGHT"]["5"]["op"], "add")
        self.assertEqual(entry["sides"]["RIGHT"]["5"]["old_line"], None)
        self.assertEqual(entry["sides"]["RIGHT"]["6"]["op"], "context")
        self.assertFalse(entry["sides"]["RIGHT"]["6"]["is_changed"])

    def test_rename_with_deletion_uses_new_path_and_old_line(self):
        result = self.build("rename_with_deletion.json", expected_file_count=1)
        entry = result["files"]["src/new-name.ts"]

        self.assertEqual(entry["status"], "renamed")
        self.assertEqual(entry["previous_filename"], "src/old-name.ts")
        self.assertEqual(entry["sides"]["LEFT"]["1"]["old_line"], 1)
        self.assertEqual(entry["sides"]["LEFT"]["1"]["op"], "delete")
        self.assertEqual(entry["sides"]["RIGHT"]["1"]["old_line"], 2)

    def test_truncated_patch_is_partial(self):
        result = self.build("truncated_patch.json", expected_file_count=1)
        entry = result["files"]["src/large.ts"]

        self.assertEqual(entry["patch_state"], "partial")
        self.assertFalse(entry["patch_integrity"]["count_match"])
        self.assertEqual(entry["patch_integrity"]["expected_additions"], 4)
        self.assertEqual(entry["patch_integrity"]["parsed_additions"], 1)
        self.assertEqual(entry["patch_integrity"]["expected_deletions"], 2)
        self.assertEqual(entry["patch_integrity"]["parsed_deletions"], 1)
        self.assertEqual(result["coverage"]["partial_files"][0]["path"], "src/large.ts")
        self.assertFalse(result["coverage"]["complete"])

    def test_truncated_hunk_is_partial_even_when_api_change_counts_match(self):
        files = [
            {
                "filename": "src/truncated-context.ts",
                "status": "modified",
                "additions": 1,
                "deletions": 1,
                "changes": 2,
                "patch": "@@ -1,3 +1,3 @@\n-old\n+new\n context",
            }
        ]
        result = DIFFMAP.build_diffmap(
            files,
            base_sha=BASE_SHA,
            merge_base_sha=MERGE_BASE_SHA,
            head_sha=HEAD_SHA,
            expected_file_count=1,
            patterns=[],
        )

        entry = result["files"]["src/truncated-context.ts"]
        self.assertEqual(entry["patch_state"], "partial")
        self.assertEqual(entry["patch_integrity"]["incomplete_hunks"], 1)
        self.assertTrue(entry["patch_integrity"]["count_match"])
        self.assertFalse(entry["patch_integrity"]["hunks_complete"])
        self.assertFalse(entry["patch_integrity"]["complete"])

    def test_slurped_pages_are_flattened_and_counted(self):
        result = self.build("slurped_pages.json", expected_file_count=2)

        self.assertEqual(list(result["files"]), ["src/a.ts", "src/b.ts"])
        self.assertEqual(result["coverage"]["fetched_file_count"], 2)
        self.assertTrue(result["coverage"]["file_count_match"])
        self.assertEqual(
            result["coverage"]["complete_files"], ["src/a.ts", "src/b.ts"]
        )
        self.assertTrue(result["coverage"]["complete"])

    def test_expected_count_mismatch_and_api_limit_are_explicit(self):
        result = self.build("slurped_pages.json", expected_file_count=3001)

        self.assertFalse(result["coverage"]["file_count_match"])
        self.assertTrue(result["coverage"]["api_file_limit_candidate"])
        self.assertFalse(result["coverage"]["complete"])

    def test_missing_and_excluded_files_are_coverage_gaps(self):
        files = [
            {
                "filename": "assets/logo.png",
                "status": "modified",
                "additions": 0,
                "deletions": 0,
                "changes": 0,
            },
            {
                "filename": "vendor/generated.ts",
                "status": "modified",
                "additions": 1,
                "deletions": 0,
                "changes": 1,
                "patch": "@@ -0,0 +1 @@\n+generated",
            },
        ]
        result = DIFFMAP.build_diffmap(
            files,
            base_sha=BASE_SHA,
            merge_base_sha=MERGE_BASE_SHA,
            head_sha=HEAD_SHA,
            expected_file_count=2,
            patterns=["vendor/**"],
        )

        self.assertEqual(result["files"]["assets/logo.png"]["patch_state"], "missing")
        self.assertEqual(
            result["files"]["vendor/generated.ts"]["patch_state"], "excluded"
        )
        self.assertEqual(result["coverage"]["missing_patch"][0]["path"], "assets/logo.png")
        self.assertEqual(
            result["coverage"]["excluded_files"][0]["path"],
            "vendor/generated.ts",
        )
        self.assertFalse(result["coverage"]["complete"])

    def test_duplicate_path_across_pages_is_rejected(self):
        files = self.load_files("slurped_pages.json")
        with self.assertRaisesRegex(ValueError, "duplicate filename"):
            DIFFMAP.build_diffmap(
                [files[0], files[0]],
                base_sha=BASE_SHA,
                merge_base_sha=MERGE_BASE_SHA,
                head_sha=HEAD_SHA,
                expected_file_count=2,
                patterns=[],
            )

    def test_snapshot_inputs_are_required_by_builder(self):
        files = self.load_files("guard_deletion.json")
        with self.assertRaisesRegex(ValueError, "base_sha"):
            DIFFMAP.build_diffmap(files, "", MERGE_BASE_SHA, HEAD_SHA, 1, [])
        with self.assertRaisesRegex(ValueError, "merge_base_sha"):
            DIFFMAP.build_diffmap(files, BASE_SHA, "", HEAD_SHA, 1, [])
        with self.assertRaisesRegex(ValueError, "head_sha"):
            DIFFMAP.build_diffmap(files, BASE_SHA, MERGE_BASE_SHA, "", 1, [])
        with self.assertRaisesRegex(ValueError, "expected_file_count"):
            DIFFMAP.build_diffmap(
                files, BASE_SHA, MERGE_BASE_SHA, HEAD_SHA, -1, []
            )

    def test_cli_writes_schema_v2(self):
        fixture = FIXTURE_DIR / "guard_deletion.json"
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "diffmap.json"
            env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--input",
                    str(fixture),
                    "--base-sha",
                    BASE_SHA,
                    "--merge-base-sha",
                    MERGE_BASE_SHA,
                    "--head-sha",
                    HEAD_SHA,
                    "--expected-file-count",
                    "1",
                    "--output",
                    str(output),
                ],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema_version"], 2)
            self.assertEqual(payload["base_sha"], BASE_SHA)
            self.assertEqual(payload["merge_base_sha"], MERGE_BASE_SHA)
            self.assertEqual(payload["head_sha"], HEAD_SHA)


if __name__ == "__main__":
    unittest.main()
