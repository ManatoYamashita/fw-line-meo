#!/usr/bin/env python3
"""pr-critical-review の図解 HTML を組み立てる。

  expand     <!--SRC path start end hi=a-b--> を実ファイルのコードへ展開する（冪等）
  validate   公開前チェック。exit 1 なら公開しない
  standalone fragment を単体 HTML にラップする
  self-check 内部ロジックの自己検査

行番号を手打ちしないための道具なので、行の切り出しは必ず実ファイル
（--ref 指定時は git show {ref}:{path}）から行う。
"""

import argparse
import html
import os
import re
import subprocess
import sys

OPEN_RE = re.compile(
    r"<!--SRC\s+(?P<path>\S+)\s+(?P<start>\d+)\s+(?P<end>\d+)"
    r"(?:\s+hi=(?P<hi>[\d,\-]+))?\s*-->"
)
CLOSE = "<!--/SRC-->"
MAX_BYTES = 16 * 1024 * 1024


# ---------------------------------------------------------------- expand


def parse_hi(spec):
    """'12-14,18' -> {12, 13, 14, 18}"""
    lines = set()
    if not spec:
        return lines
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            lines.update(range(int(a), int(b) + 1))
        else:
            lines.add(int(part))
    return lines


def read_source(path, ref, cache):
    key = (ref, path)
    if key in cache:
        return cache[key]
    if ref:
        proc = subprocess.run(
            ["git", "show", "{}:{}".format(ref, path)],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise SystemExit(
                "git show {}:{} に失敗しました: {}".format(
                    ref, path, proc.stderr.strip()
                )
            )
        text = proc.stdout
    else:
        if not os.path.exists(path):
            raise SystemExit("ファイルがありません: {}".format(path))
        with open(path, encoding="utf-8") as f:
            text = f.read()
    cache[key] = text.splitlines()
    return cache[key]


def render_block(path, start, end, hi, ref, cache):
    src = read_source(path, ref, cache)
    if start < 1 or start > len(src):
        raise SystemExit(
            "{}: 開始行 {} が範囲外です（全 {} 行）".format(path, start, len(src))
        )
    if end < start:
        raise SystemExit("{}: end({}) < start({})".format(path, end, start))
    end = min(end, len(src))
    rows = []
    for n in range(start, end + 1):
        cls = "line hl" if n in hi else "line"
        rows.append(
            '<span class="{}" data-ln="{}">{}</span>'.format(
                cls, n, html.escape(src[n - 1], quote=False)
            )
        )
    label = "{}:{}".format(path, start) if start == end else "{}:{}-{}".format(
        path, start, end
    )
    return (
        '<figure class="src">\n'
        "<figcaption>{}</figcaption>\n"
        "<pre><code>{}</code></pre>\n"
        "</figure>"
    ).format(html.escape(label, quote=False), "\n".join(rows))


def expand(text, ref):
    """プレースホルダ直後に展開済みブロックを置く。再実行しても増えない。"""
    cache = {}
    out = []
    pos = 0
    count = 0
    for m in OPEN_RE.finditer(text):
        if m.start() < pos:  # 既存ブロックの中にあった開始マーカーは無視
            continue
        out.append(text[pos : m.end()])
        close = text.find(CLOSE, m.end())
        nxt = OPEN_RE.search(text, m.end())
        if close != -1 and (nxt is None or close < nxt.start()):
            pos = close + len(CLOSE)
        else:
            pos = m.end()
        out.append(
            "\n"
            + render_block(
                m.group("path"),
                int(m.group("start")),
                int(m.group("end")),
                parse_hi(m.group("hi")),
                ref,
                cache,
            )
            + "\n"
            + CLOSE
        )
        count += 1
    out.append(text[pos:])
    return "".join(out), count


# -------------------------------------------------------------- validate

EXTERNAL_RE = re.compile(
    r"""(?:src|href)\s*=\s*["']https?://|url\(\s*["']?https?://""", re.I
)
SKELETON_RE = re.compile(r"<!doctype|<html[\s>]|<head[\s>]|<body[\s>]", re.I)
BOUNDARY_RE = re.compile(r"""class\s*=\s*["'][^"']*\bboundary\b""", re.I)
TITLE_RE = re.compile(r"<title>(.*?)</title>", re.I | re.S)


def validate(text, strict, size):
    errors, warns = [], []

    unexpanded = [
        m for m in OPEN_RE.finditer(text) if text.find(CLOSE, m.end()) == -1
    ]
    for m in unexpanded:
        errors.append(
            "未展開の SRC があります（先に expand を実行）: {}".format(
                m.group(0)
            )
        )

    for m in EXTERNAL_RE.finditer(text):
        errors.append(
            "外部リソース参照があります（自己完結にしてください）: ...{}...".format(
                text[m.start() : m.start() + 60].replace("\n", " ")
            )
        )

    m = SKELETON_RE.search(text)
    if m:
        errors.append(
            "fragment に骨格タグ {} が含まれています（Artifact 側が付けます）".format(
                m.group(0)
            )
        )

    if not TITLE_RE.search(text):
        errors.append("<title> がありません（Artifact のタブ名になります）")

    if size > MAX_BYTES:
        errors.append(
            "16MB を超えています（{:.1f}MB）".format(size / 1024 / 1024)
        )

    if not BOUNDARY_RE.search(text):
        msg = 'class に "boundary" を含む影響範囲の境界図が見つかりません'
        (errors if strict else warns).append(msg)

    return errors, warns


# ------------------------------------------------------------ standalone

SKELETON = """<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {{ color-scheme: light dark; }}
body {{ margin: 0; font: 14px/1.6 system-ui, sans-serif; }}
img {{ max-width: 100%; }}
[hidden] {{ display: none !important; }}
</style>
</head>
<body>
{body}
</body>
</html>
"""


def standalone(text, lang="ja"):
    return SKELETON.format(lang=lang, body=text)


# ------------------------------------------------------------ self-check


def self_check():
    import tempfile

    assert parse_hi("12-14,18") == {12, 13, 14, 18}
    assert parse_hi(None) == set()

    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "a.txt")
        with open(p, "w", encoding="utf-8") as f:
            f.write("one\n<two>\nthree\nfour\n")
        frag = "<title>t</title>\n<!--SRC {} 2 3 hi=2-->\n<p>後続</p>".format(p)

        once, n = expand(frag, None)
        assert n == 1
        assert "&lt;two&gt;" in once, once  # エスケープされる
        assert 'class="line hl" data-ln="2"' in once
        assert once.rstrip().endswith("<p>後続</p>")

        twice, _ = expand(once, None)
        assert twice == once, "expand が冪等でない"  # 再実行で増えない

        # 範囲外は落とす
        try:
            expand("<!--SRC {} 99 99-->".format(p), None)
            raise AssertionError("範囲外がエラーにならない")
        except SystemExit:
            pass

    e, w = validate("<title>t</title><div class='boundary'></div>", True, 10)
    assert e == [] and w == [], (e, w)
    e, _ = validate("<title>t</title>", True, 10)
    assert any("boundary" in x for x in e)
    e, w = validate("<title>t</title>", False, 10)
    assert e == [] and len(w) == 1
    e, _ = validate(
        "<title>t</title><div class='boundary'></div>"
        "<script src=\"https://cdn.example/x.js\"></script>",
        True,
        10,
    )
    assert any("外部リソース" in x for x in e)
    e, _ = validate("<div class='boundary'></div>", True, 10)
    assert any("<title>" in x for x in e)

    assert "<!doctype html>" in standalone("<p>x</p>")
    print("self-check ok")


# ------------------------------------------------------------------ main


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("expand", help="SRC プレースホルダを展開する（上書き）")
    e.add_argument("file")
    e.add_argument("--ref", help="git ref。省略時は作業ツリーを読む")

    v = sub.add_parser("validate", help="公開前チェック")
    v.add_argument("file")
    v.add_argument(
        "--strict", action="store_true", help="境界図の欠落をエラーに昇格"
    )

    s = sub.add_parser("standalone", help="単体 HTML を書き出す")
    s.add_argument("file")
    s.add_argument("out")
    s.add_argument("--lang", default="ja")

    sub.add_parser("self-check", help="内部ロジックの自己検査")

    args = ap.parse_args()

    if args.cmd == "self-check":
        self_check()
        return 0

    with open(args.file, encoding="utf-8") as f:
        text = f.read()

    if args.cmd == "expand":
        new, n = expand(text, args.ref)
        if new != text:
            with open(args.file, "w", encoding="utf-8") as f:
                f.write(new)
        print(
            "expanded {} block(s) ({}) -> {}".format(
                n, args.ref or "working tree", args.file
            )
        )
        return 0

    if args.cmd == "validate":
        errors, warns = validate(
            text, args.strict, os.path.getsize(args.file)
        )
        for w in warns:
            print("WARN  " + w)
        for x in errors:
            print("ERROR " + x)
        if errors:
            print("\n{} error(s). 公開しないでください。".format(len(errors)))
            return 1
        print("ok ({} warning(s))".format(len(warns)))
        return 0

    if args.cmd == "standalone":
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(standalone(text, args.lang))
        print(os.path.abspath(args.out))
        return 0


if __name__ == "__main__":
    sys.exit(main())
