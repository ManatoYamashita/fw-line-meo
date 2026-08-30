# 参照デザインシステムの原典（upstream）

このディレクトリは、fw-line-meo の意匠が参照した**外部デザインシステム文書の逐語コピー**を保持する。

## ここにあるもの / ここに無いもの

| | |
|---|---|
| ここにあるもの | 上流の**無改変**コピー。上流が更新されたときに差分を取るための基準点 |
| ここに**無い**もの | **このプロジェクトの設計**。原典と我々の設計は 10 点以上で意図的に乖離している（後述） |

**このプロジェクトのデザイン言語は `docs/design/design-language.md` が正典である。**
本ディレクトリの内容を「我々の設計」として読んではならない。

> ディレクトリ名が `vendor` ではなく `upstream` なのは、`.gitignore:30` の `vendor/`（Go の依存ベンダリング用）が
> パス位置を問わず一致し、このディレクトリを追跡対象から外してしまうためである。
> 名前を戻すなら `.gitignore` 側に否定規則が要る。

## 取得記録

| 項目 | 値 |
|---|---|
| ファイル | `airbnb-DESIGN.md` |
| 上流リポジトリ | <https://github.com/VoltAgent/awesome-design-md> |
| 上流パス | `design-md/airbnb/DESIGN.md` |
| 取得時点のコミット | `e06a9666` （当該ファイルを最後に変更したコミット・2026-05-17） |
| 取得日 | 2026-08-30 |
| 取得方法 | GitHub Contents API（`gh api repos/VoltAgent/awesome-design-md/contents/design-md/airbnb/DESIGN.md`） |
| ライセンス | MIT License（`LICENSE-awesome-design-md` に全文を同梱） |
| 関連 Issue | [#173](https://github.com/ManatoYamashita/fw-line-meo/issues/173)（親 [#41](https://github.com/ManatoYamashita/fw-line-meo/issues/41)） |

上流を更新するときは次のとおり差分を取る。

```
gh api "repos/VoltAgent/awesome-design-md/contents/design-md/airbnb/DESIGN.md" --jq '.content' \
  | base64 -d | diff -u docs/design/vendor/airbnb-DESIGN.md -
```

## 上流の免責（原文）

> This repository is a curated collection of design system documents extracted from public websites.
> All DESIGN.md files are provided "as is" without warranty. The extracted design tokens represent
> publicly visible CSS values. We do not claim ownership of any site's visual identity.
> These documents exist to help AI agents generate consistent UI.

MIT License が及ぶのは VoltAgent が作成した**文書**であって、そこに記述された第三者のブランド資産ではない。
参照した色や形をこのプロダクトのブランドとして採用する判断は、ライセンスとは別の事業判断であり、
その判断そのものは #173 と `docs/design/design-language.md` に記録する。

## 原典から採らなかったもの（要約）

詳細と根拠は `docs/design/design-language.md` にある。ここでは「無改変コピーをそのまま実装だと
読まないための最小限の注意」として列挙する。

- **アクセント色をそのまま CTA に使っていない。** 原典の primary は白文字と 3.52:1 で WCAG AA（4.5:1）に届かない。装飾専用の役割へ降格し、CTA には原典の押下時の色を採った
- **原典の muted-soft・legal-link・border-strong・disabled tint は採用していない**（いずれも AA または SC 1.4.11 の閾値に届かない）
- **原典のエラー色は淡い面の上で 4.08:1 になるため採用していない。** エラー族の暗い方を採った
- **フォントを変えていない。** 原典のフォントは商用ライセンスであり、原典が代替として挙げる書体は日本語字形を持たない
- **原典の 8px / 11px / 13px の文字サイズ段は採用していない**（日本語字形で判読性に難がある）
- **角丸スケールの段そのものは上書きしていない。** 原典の形は既存の段への役割割当で表現している
- **LINE Flex Message の色は原典を適用していない。** LINE アプリ自身の配色の中で成立させるため現行を維持する
