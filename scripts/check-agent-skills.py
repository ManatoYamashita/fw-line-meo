#!/usr/bin/env python3
"""リポジトリ同梱スキルの実体・参照・登録内容を追加依存なしで検証する。"""

from pathlib import Path
import argparse
import hashlib
import json
import re
import sys
from urllib.parse import unquote


def snapshot(directory):
    digest = hashlib.sha256()
    files = sorted(
        p for p in directory.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and p.suffix not in {".pyc", ".pyo"}
    )
    for path in files:
        digest.update(path.relative_to(directory).as_posix().encode() + b"\0")
        digest.update(path.read_bytes() + b"\0")
    return len(files), digest.hexdigest()


def check(root):
    errors = []
    manifest_path = root / "docs/agent-skills/manifest.json"
    if not manifest_path.is_file():
        return ["スキルの出典・登録 manifest がありません"]
    try:
        manifest = json.loads(manifest_path.read_text())
        entries = manifest["skills"]
    except (ValueError, KeyError, TypeError) as error:
        return [f"manifest を読めません: {error}"]
    if not entries:
        return ["スキルを1件も検証できません"]
    skills = root / ".agents/skills"
    if not skills.is_dir():
        return [".agents/skills の実体がありません"]
    declared = [entry["name"] for entry in entries]
    discovered = {p.name for p in skills.iterdir() if (p / "SKILL.md").is_file()}
    if len(declared) != len(set(declared)):
        errors.append("manifest に重複するスキルがあります")
    if set(declared) != discovered:
        errors.append(f"登録と実体の差分: {sorted(set(declared) ^ discovered)}")
    for entry in entries:
        directory = root / entry["path"]
        if directory.resolve().is_relative_to(root.resolve()) is False:
            errors.append(f"{entry['name']}: リポジトリ外への参照です")
            continue
        if not (directory / "SKILL.md").is_file():
            errors.append(f"{entry['name']}: SKILL.md がありません")
            continue
        text = (directory / "SKILL.md").read_text()
        front = re.match(r"\A---\n(.*?)\n---(?:\n|$)", text, re.S)
        if not front or not re.search(r"^name:\s*" + re.escape(entry["name"]) + r"\s*$", front[1], re.M):
            errors.append(f"{entry['name']}: frontmatter の名前が一致しません")
        if front and not re.search(r"^description:\s*\S", front[1], re.M):
            errors.append(f"{entry['name']}: description がありません")
        count, digest = snapshot(directory)
        if count != entry.get("fileCount") or digest != entry.get("vendoredSha256"):
            errors.append(f"{entry['name']}: 配布内容が manifest と一致しません")
        license_path = entry.get("licenseFile")
        if license_path and not (root / license_path).is_file():
            errors.append(f"{entry['name']}: ライセンス文書がありません")

    # スキル内リンクは文書からの相対参照、プロジェクトパスはルート参照を認めます。
    markdown = set(skills.rglob("*.md"))
    markdown.update((root / ".claude/skills/messaging-api").rglob("*.md"))
    for path in sorted(markdown):
        text = path.read_text()
        if re.search(r"/Users/|~/(?:\.claude|\.codex|\.agents)/skills/", text):
            errors.append(f"{path.relative_to(root)}: 個人PCへの固定参照があります")
        for target in re.findall(r"(?<!!)\[[^\]]*\]\(([^)]+)\)", text):
            target = unquote(target.split("#", 1)[0].strip())
            if not target or re.match(r"[a-z]+:", target) or any(c in target for c in "<>{}$"):
                continue
            if not (path.parent / target).exists() and not (root / target).exists():
                errors.append(f"{path.relative_to(root)}: 参照先がありません: {target}")
    for path in skills.rglob("*"):
        if path.is_symlink() and not path.resolve().is_relative_to(root.resolve()):
            errors.append(f"{path.relative_to(root)}: リポジトリ外へのsymlinkです")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    root = parser.parse_args().root.resolve()
    errors = check(root)
    for error in errors:
        print(f"FAIL: {error}", file=sys.stderr)
    if errors:
        return 1
    print("PASS: リポジトリ同梱スキルの登録・実体・内部参照・配布ハッシュ")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
