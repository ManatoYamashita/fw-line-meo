"""配布時に起こりうる欠落・リンク切れ・外部参照を実ファイルで再現します。"""

from pathlib import Path
import importlib.util
import json
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "check-agent-skills.py"
SPEC = importlib.util.spec_from_file_location("agent_skills_check", SCRIPT)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class AgentSkillsCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.skill = self.root / ".agents/skills/demo"
        self.skill.mkdir(parents=True)
        (self.skill / "SKILL.md").write_text(
            "---\nname: demo\ndescription: Demo skill\n---\n[資料](reference.md)\n"
        )
        (self.skill / "reference.md").write_text("# Reference\n")
        (self.root / "docs/agent-skills").mkdir(parents=True)
        self.manifest = self.root / "docs/agent-skills/manifest.json"
        count, digest = CHECKER.snapshot(self.skill)
        self.entry = {"name": "demo", "path": ".agents/skills/demo", "fileCount": count, "vendoredSha256": digest}
        self.write_manifest([self.entry])

    def write_manifest(self, entries):
        self.manifest.write_text(json.dumps({"skills": entries}))

    def assert_failure(self, message):
        errors = CHECKER.check(self.root)
        self.assertTrue(any(message in error for error in errors), errors)

    def test_complete_bundle_passes(self):
        self.assertEqual(CHECKER.check(self.root), [])

    def test_missing_asset_is_rejected(self):
        (self.skill / "reference.md").unlink()
        self.assert_failure("参照先がありません")

    def test_modified_asset_is_rejected(self):
        (self.skill / "reference.md").write_text("Changed\n")
        self.assert_failure("配布内容が manifest と一致しません")

    def test_undeclared_skill_is_rejected(self):
        other = self.skill.parent / "other"
        other.mkdir()
        (other / "SKILL.md").write_text("---\nname: other\ndescription: Other\n---\n")
        self.assert_failure("登録と実体の差分")

    def test_external_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as external:
            (self.skill / "outside").symlink_to(external, target_is_directory=True)
            self.assert_failure("リポジトリ外へのsymlink")

    def test_internal_symlink_passes(self):
        target = self.root / ".claude/skills/demo"
        target.parent.mkdir(parents=True)
        self.skill.rename(target)
        self.skill.symlink_to("../../.claude/skills/demo", target_is_directory=True)
        self.assertEqual(CHECKER.check(self.root), [])

    def test_personal_path_is_rejected(self):
        (self.skill / "reference.md").write_text("Read /Users/example/.codex/skills/demo\n")
        self.assert_failure("個人PCへの固定参照")

    def test_missing_manifest_is_rejected(self):
        self.manifest.unlink()
        self.assert_failure("manifest がありません")

    def test_empty_bundle_does_not_return_success(self):
        self.write_manifest([])
        self.assert_failure("1件も検証できません")

    def test_missing_skill_directory_is_rejected(self):
        (self.skill / "SKILL.md").unlink()
        self.assert_failure("SKILL.md がありません")


if __name__ == "__main__":
    unittest.main()
