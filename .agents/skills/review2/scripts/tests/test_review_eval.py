from __future__ import annotations

import copy
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "review_eval.py"
SPEC = importlib.util.spec_from_file_location("review_eval", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"could not load {SCRIPT_PATH}")
EVAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EVAL)

BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40
REVIEWER = {
    "name": "blind-reviewer",
    "model": "test-model",
    "version": "test-version",
    "reasoning_effort": "medium",
}


def public_case(case_id: str) -> dict:
    return {
        "case_id": case_id,
        "title": "Update resource handling",
        "pr_body": "Keep resource updates consistent.",
        "base_sha": BASE_SHA,
        "head_sha": HEAD_SHA,
        "rules": ["Review only PR-attributable behavior."],
        "checks": ["unit: passed"],
        "changed_files": [
            {
                "path": "src/service.py",
                "patch": "@@ -10 +10 @@\n-old_call()\n+new_call()",
            }
        ],
        "context_files": [],
    }


def cases_document(*case_ids: str) -> dict:
    return {
        "schema_version": 1,
        "corpus_version": "1.0.0",
        "cases": [public_case(case_id) for case_id in case_ids],
    }


def taxonomy_document() -> dict:
    return {
        "schema_version": 1,
        "taxonomy_version": "1.0.0",
        "issue_codes": [
            {
                "code": "authorization-bypass",
                "category": "security",
                "description": "An authorization control can be bypassed.",
            }
        ],
    }


def truth_finding(
    *,
    truth_id: str = "T-001",
    severity: str = "High",
    start: int = 10,
    end: int = 10,
) -> dict:
    return {
        "truth_id": truth_id,
        "severity": severity,
        "evidence_level": "E2",
        "accepted_matchers": [
            {
                "issue_code": "authorization-bypass",
                "category": "security",
                "path": "src/service.py",
                "anchors": [{"side": "RIGHT", "start": start, "end": end}],
            }
        ],
    }


def regression_truth(case_id: str, *, severity: str = "High") -> dict:
    return {
        "case_id": case_id,
        "case_kind": "regression",
        "findings": [truth_finding(truth_id=f"T-{case_id}", severity=severity)],
    }


def negative_truth(case_id: str) -> dict:
    return {
        "case_id": case_id,
        "case_kind": "no-finding",
        "negative_reason": "The behavior already exists on the base snapshot.",
        "findings": [],
    }


def truth_document(*truth_cases: dict) -> dict:
    return {
        "schema_version": 1,
        "corpus_version": "1.0.0",
        "cases": list(truth_cases),
    }


def prediction(
    prediction_id: str,
    *,
    severity: str = "High",
    line: int = 10,
) -> dict:
    return {
        "prediction_id": prediction_id,
        "verdict": "KEEP",
        "severity": severity,
        "confidence": "high",
        "issue_code": "authorization-bypass",
        "category": "security",
        "path": "src/service.py",
        "side": "RIGHT",
        "line": line,
        "claim": "A caller can update a resource without an ownership check.",
    }


def predicted_case(case_id: str, findings: list[dict]) -> dict:
    return {
        "case_id": case_id,
        "base_sha": BASE_SHA,
        "head_sha": HEAD_SHA,
        "coverage_status": "complete",
        "findings": findings,
    }


def predictions_document(*prediction_cases: dict, run_id: str = "run-001") -> dict:
    return {
        "schema_version": 1,
        "corpus_version": "1.0.0",
        "run_id": run_id,
        "reviewer": REVIEWER,
        "cases": list(prediction_cases),
    }


def score(
    cases: dict,
    truth: dict,
    predictions: dict,
) -> dict:
    return EVAL.score_predictions({}, cases, truth, predictions)


def score_report(run_id: str, scored: dict) -> dict:
    return {
        "schema_version": 1,
        "status": "valid",
        "execution_mode": "live",
        "run_id": run_id,
        "replicate_id": int(run_id.rsplit("-", 1)[-1]),
        "corpus_version": "1.0.0",
        "cases_digest": "cases-digest",
        "diffmap_digest": "diffmap-digest",
        "truth_digest": "truth-digest",
        "taxonomy_digest": "taxonomy-digest",
        "skill_digest": "candidate-skill-digest",
        "prompt_digest": "prompt-digest",
        "scorer_digest": "scorer-digest",
        "model_digest": "model-digest",
        "tool_policy_digest": "tool-policy-digest",
        "blind": True,
        "reviewer": REVIEWER,
        "counts": scored["counts"],
        "metrics": scored["metrics"],
        "severity_confusion": scored["severity_confusion"],
        "case_results": scored["case_results"],
        "truth_outcomes": scored["truth_outcomes"],
    }


def write_json(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def prediction_schema() -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["schema_version", "corpus_version", "run_id", "reviewer", "cases"],
        "properties": {
            "schema_version": {"type": "integer", "const": 1},
            "corpus_version": {"type": "string", "const": "1.0.0"},
            "run_id": {"type": "string"},
            "reviewer": {
                "type": "object",
                "additionalProperties": False,
                "required": ["name", "model", "version"],
                "properties": {
                    "name": {"type": "string"},
                    "model": {"type": "string"},
                    "version": {"type": "string"},
                },
            },
            "cases": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "case_id", "base_sha", "head_sha", "coverage_status", "findings"
                    ],
                    "properties": {
                        "case_id": {"type": "string"},
                        "base_sha": {"type": "string"},
                        "head_sha": {"type": "string"},
                        "coverage_status": {
                            "type": "string",
                            "enum": ["complete", "partial", "blocked"],
                        },
                        "findings": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": [
                                    "prediction_id", "verdict", "severity", "confidence",
                                    "issue_code", "category", "path", "side", "line", "claim"
                                ],
                                "properties": {
                                    "prediction_id": {"type": "string"},
                                    "verdict": {
                                        "type": "string",
                                        "enum": ["KEEP", "DOWNGRADE", "REJECT", "REVIEW"],
                                    },
                                    "severity": {
                                        "type": "string",
                                        "enum": ["High", "Middle", "Low", "Nit"],
                                    },
                                    "confidence": {
                                        "type": "string",
                                        "enum": ["high", "medium", "low"],
                                    },
                                    "issue_code": {
                                        "type": "string",
                                        "enum": ["authorization-bypass"],
                                    },
                                    "category": {"type": "string", "enum": ["security"]},
                                    "path": {"type": "string"},
                                    "side": {"type": "string", "enum": ["LEFT", "RIGHT"]},
                                    "line": {"type": "integer"},
                                    "claim": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
        },
    }


class ReviewEvalScoringTests(unittest.TestCase):
    def test_strict_match_is_true_positive(self):
        cases = cases_document("case-001")
        truth = truth_document(regression_truth("case-001"))
        predictions = predictions_document(
            predicted_case("case-001", [prediction("P-001")])
        )

        result = score(cases, truth, predictions)

        self.assertEqual(result["counts"]["material"], {"tp": 1, "fp": 0, "fn": 0})
        self.assertEqual(result["counts"]["High"], {"tp": 1, "fp": 0, "fn": 0})
        self.assertEqual(result["counts"]["Middle"], {"tp": 0, "fp": 0, "fn": 0})
        self.assertEqual(result["metrics"]["severity_agreement"], 1.0)
        self.assertEqual(result["severity_confusion"]["High"]["High"], 1)

    def test_high_truth_predicted_middle_preserves_pooled_match(self):
        cases = cases_document("case-001")
        truth = truth_document(regression_truth("case-001", severity="High"))
        predictions = predictions_document(
            predicted_case(
                "case-001",
                [prediction("P-001", severity="Middle")],
            )
        )

        result = score(cases, truth, predictions)

        self.assertEqual(result["counts"]["material"], {"tp": 1, "fp": 0, "fn": 0})
        self.assertEqual(result["counts"]["High"], {"tp": 0, "fp": 0, "fn": 1})
        self.assertEqual(result["counts"]["Middle"], {"tp": 0, "fp": 1, "fn": 0})
        self.assertEqual(result["metrics"]["severity_agreement"], 0.0)
        self.assertEqual(result["severity_confusion"]["High"]["Middle"], 1)

    def test_duplicate_prediction_is_false_positive(self):
        cases = cases_document("case-001")
        truth = truth_document(regression_truth("case-001"))
        predictions = predictions_document(
            predicted_case(
                "case-001",
                [prediction("P-001"), prediction("P-002")],
            )
        )

        result = score(cases, truth, predictions)

        self.assertEqual(result["counts"]["material"], {"tp": 1, "fp": 1, "fn": 0})
        self.assertEqual(result["counts"]["duplicate_false_positives"], 1)
        self.assertEqual(
            result["case_results"][0]["duplicate_prediction_ids"],
            ["P-002"],
        )

    def test_wrong_line_is_localization_error_and_not_true_positive(self):
        cases = cases_document("case-001")
        truth = truth_document(regression_truth("case-001"))
        predictions = predictions_document(
            predicted_case("case-001", [prediction("P-001", line=99)])
        )

        result = score(cases, truth, predictions)

        self.assertEqual(result["counts"]["material"], {"tp": 0, "fp": 1, "fn": 1})
        self.assertEqual(result["counts"]["semantic_localization_errors"], 1)
        self.assertEqual(result["metrics"]["localization_accuracy"], 0.0)
        self.assertEqual(
            result["case_results"][0]["localization_error_prediction_ids"],
            ["P-001"],
        )

    def test_negative_case_prediction_is_attribution_false_positive(self):
        cases = cases_document("case-001")
        truth = truth_document(negative_truth("case-001"))
        predictions = predictions_document(
            predicted_case("case-001", [prediction("P-001")])
        )

        result = score(cases, truth, predictions)

        self.assertEqual(result["counts"]["material"], {"tp": 0, "fp": 1, "fn": 0})
        self.assertEqual(result["counts"]["attribution_false_positives"], 1)
        self.assertEqual(result["counts"]["negative_cases"], 1)
        self.assertEqual(result["counts"]["negative_cases_clean"], 0)
        self.assertEqual(result["metrics"]["negative_case_accuracy"], 0.0)

    def test_missing_case_reduces_coverage_and_counts_false_negative(self):
        cases = cases_document("case-positive", "case-negative")
        truth = truth_document(
            regression_truth("case-positive"),
            negative_truth("case-negative"),
        )
        predictions = predictions_document(
            predicted_case("case-negative", [])
        )

        result = score(cases, truth, predictions)

        self.assertEqual(result["counts"]["material"], {"tp": 0, "fp": 0, "fn": 1})
        self.assertEqual(result["counts"]["cases_expected"], 2)
        self.assertEqual(result["counts"]["cases_returned"], 1)
        self.assertEqual(result["metrics"]["case_coverage"], 0.5)
        positive = next(
            item for item in result["case_results"] if item["case_id"] == "case-positive"
        )
        self.assertEqual(positive["missed_truth_ids"], ["T-case-positive"])


class ReviewEvalPackTests(unittest.TestCase):
    def test_pack_does_not_include_oracle_artifact_or_content(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            cases_path = root / "cases.json"
            taxonomy_path = root / "taxonomy.json"
            schema_path = root / "prediction.schema.json"
            prompt_path = root / "prompt.md"
            oracle_path = root / "private-truth.json"
            skill_root = root / "skill"
            output = root / "pack"

            write_json(cases_path, cases_document("case-001"))
            write_json(taxonomy_path, taxonomy_document())
            write_json(schema_path, prediction_schema())
            prompt_path.write_text("Review every supplied case.\n", encoding="utf-8")
            oracle_marker = "private-ground-truth-marker-530000"
            oracle_path.write_text(oracle_marker, encoding="utf-8")
            (skill_root / "references").mkdir(parents=True)
            (skill_root / "SKILL.md").write_text(
                "---\nname: test-review\ndescription: Test review skill.\n---\n\n# Review\n",
                encoding="utf-8",
            )
            (skill_root / "references" / "rubric.md").write_text(
                "Review concrete regressions.\n",
                encoding="utf-8",
            )

            with contextlib.redirect_stdout(io.StringIO()):
                result = EVAL.command_pack(
                    SimpleNamespace(
                        cases=cases_path,
                        taxonomy=taxonomy_path,
                        prediction_schema=schema_path,
                        prompt=prompt_path,
                        skill_root=skill_root,
                        run_id="run-001",
                        replicate_id=1,
                        shuffle_seed=7,
                        reviewer_name=REVIEWER["name"],
                        model=REVIEWER["model"],
                        model_version=REVIEWER["version"],
                        reasoning_effort=REVIEWER["reasoning_effort"],
                        isolation_mode="verified",
                        output=output,
                    )
                )

            self.assertEqual(result, 0)
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertFalse(manifest["isolation"]["oracle_in_pack"])
            diffmap = json.loads((output / "diffmap.json").read_text(encoding="utf-8"))
            reviewable = diffmap["cases"][0]["files"][0]["reviewable_changed_lines"]
            self.assertEqual(reviewable, {"LEFT": [10], "RIGHT": [10]})
            forbidden_names = {"oracle", "truth", "ground-truth", "baseline", "history"}
            for path in output.rglob("*"):
                self.assertNotIn(path.name.lower(), forbidden_names)
                if path.is_file():
                    self.assertNotIn(oracle_marker, path.read_text(encoding="utf-8"))


class ReviewEvalOperationsTests(unittest.TestCase):
    def make_aggregate(self, root: Path) -> Path:
        cases = cases_document("case-001")
        truth = truth_document(regression_truth("case-001"))
        scored = score(
            cases,
            truth,
            predictions_document(
                predicted_case("case-001", [prediction("P-001")])
            ),
        )
        score_paths = []
        for replicate in (1, 2):
            path = root / f"score-{replicate}.json"
            write_json(path, score_report(f"run-{replicate}", scored))
            score_paths.append(path)
        aggregate_path = root / "aggregate.json"
        result = EVAL.command_aggregate(
            SimpleNamespace(
                score=score_paths,
                measurement_id="measurement-candidate",
                output=aggregate_path,
            )
        )
        self.assertEqual(result, 0)
        return aggregate_path

    def test_aggregate_pools_runs_and_reports_stability(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            aggregate_path = self.make_aggregate(root)

            aggregate = json.loads(aggregate_path.read_text(encoding="utf-8"))

            self.assertEqual(aggregate["run_count"], 2)
            self.assertEqual(aggregate["counts"]["material"], {"tp": 2, "fp": 0, "fn": 0})
            self.assertEqual(aggregate["metrics"]["material_recall"], 1.0)
            self.assertEqual(aggregate["macro"]["material_recall"]["stdev"], 0.0)
            self.assertEqual(aggregate["severity_confusion"]["High"]["High"], 2)
            self.assertEqual(aggregate["miss_rate_by_truth"]["T-case-001"]["miss_rate"], 0.0)

    def test_compare_fails_absolute_and_delta_regression(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            aggregate_path = self.make_aggregate(root)
            baseline = json.loads(aggregate_path.read_text(encoding="utf-8"))
            baseline["measurement_id"] = "measurement-baseline"
            candidate = copy.deepcopy(baseline)
            candidate["measurement_id"] = "measurement-candidate"
            candidate["metrics"]["high_recall"] = 0.5
            candidate_path = root / "candidate.json"
            baseline_path = root / "baseline.json"
            policy_path = root / "policy.json"
            comparison_path = root / "comparison.json"
            write_json(candidate_path, candidate)
            write_json(baseline_path, baseline)
            write_json(
                policy_path,
                {
                    "min_replicates": 2,
                    "absolute_min": {"high_recall": 0.9},
                    "absolute_max": {"false_positives_per_case": 0.0},
                    "max_drop": {"high_recall": 0.0},
                    "max_increase": {"false_positives_per_case": 0.0},
                    "require_zero_high_miss_runs": True,
                },
            )

            result = EVAL.command_compare(
                SimpleNamespace(
                    candidate=candidate_path,
                    baseline=baseline_path,
                    policy=policy_path,
                    output=comparison_path,
                )
            )

            self.assertEqual(result, 1)
            comparison = json.loads(comparison_path.read_text(encoding="utf-8"))
            self.assertEqual(comparison["status"], "fail")
            self.assertTrue(
                any("below floor" in violation for violation in comparison["violations"])
            )
            self.assertTrue(
                any("dropped" in violation for violation in comparison["violations"])
            )

    def test_record_rejects_duplicate_measurement_id(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            aggregate_path = self.make_aggregate(root)
            history_path = root / "history.jsonl"
            args = SimpleNamespace(aggregate=aggregate_path, history=history_path)

            self.assertEqual(EVAL.command_record(args), 0)
            with self.assertRaisesRegex(
                EVAL.EvalError,
                "history already contains measurement_id",
            ):
                EVAL.command_record(args)

            lines = history_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0])["measurement_id"], "measurement-candidate")


if __name__ == "__main__":
    unittest.main()
