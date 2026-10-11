# AGENTS.md

このリポジトリでエージェントが従う指示の正典は [`CLAUDE.md`](CLAUDE.md) である。作業を始める前に CLAUDE.md を全文読み、その指示に従うこと。

このファイルには規則を書かない。規則を 2 か所に持つと、片方だけが更新されて食い違う。規則を足す・直すときは CLAUDE.md を編集する。

Claude Code 以外のエージェントが CLAUDE.md を読むときの読み替え:

- `.claude/skills/<name>/` のスキルは、`SKILL.md` と同じディレクトリの `references/` を直接読んで使う。パスは読み替えない（LINE Messaging API なら `.claude/skills/messaging-api/`）。
- `/kiro-*` などのスラッシュコマンドは Claude Code のコマンドである。使えない場合は `.kiro/specs/` と `.kiro/steering/` の成果物を直接読み書きし、各フェーズで人間のレビューを挟む規律は同じく守る。
