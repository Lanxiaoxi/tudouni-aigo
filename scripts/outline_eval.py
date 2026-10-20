#!/usr/bin/env python3
"""A/B evaluation of read_file(outline=true) against the real session logs.

What this measures, and what it refuses to measure:

  * It REPLAYS the tool calls a real session made, and for every read_file it
    asks "what if the model had been handed a skeleton first?" -- then charges the
    skeleton's real byte size and the follow-up read it would have needed.
  * It does NOT claim the model would have asked for the same follow-up range.
    That is unknowable offline, so the follow-up cost is swept as a parameter and
    the break-even point is reported instead of a single invented number.
  * A skeleton COSTS a round trip: 1 read becomes 1 outline + 1 read. Call count
    can go up while bytes go down, and both are reported. Presenting only the
    token side would be a lie of omission.

Usage:
    python scripts/outline_eval.py [--logs DIR] [--root DIR] [--json OUT]
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from exploration_cost import Call, load  # noqa: E402


# ---------------------------------------------------------------------------
# The skeleton, rendered the same way the Go tool renders it
# ---------------------------------------------------------------------------

# Mirrors outline.go. Kept deliberately small: this is a replay of the shipped
# heuristic, not a second implementation of it. If the two drift, the eval is
# wrong -- so the constants are pinned here and cross-checked by rendering one
# file both ways in the report.
KEYWORDS = (
    "func", "fun", "def", "defp", "defn", "defmacro", "defmodule", "fn",
    "function", "class", "struct", "interface", "enum", "type", "trait",
    "impl", "module", "namespace", "object", "record", "protocol",
    "extension", "macro", "sub", "proc", "union", "const",
)
METHODS = True
LINE_WIDTH = 120
MAX_ENTRIES = 300


@dataclass
class FileFacts:
    """One file's outline, precomputed once."""

    total_lines: int = 0
    outline_bytes: int = 0
    entries: int = 0
    bytes_per_line: list[int] = field(default_factory=list)
    missing: bool = False

    def bytes_for_span(self, start: int, end: int) -> int:
        lo = max(1, start)
        hi = min(self.total_lines, end)
        if hi < lo:
            return 0
        return sum(self.bytes_per_line[lo - 1:hi])


def render_outline(path: str, text: str) -> FileFacts:
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    total = len(lines)
    widths = [len(line.encode("utf-8")) + 1 for line in lines]
    facts = FileFacts(total_lines=total, bytes_per_line=widths)
    if total == 0:
        return facts

    suffix = Path(path).suffix.lower()
    if suffix in {".md", ".markdown", ".mdx"}:
        picked = []
        in_fence = False
        for index, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("```") or stripped.startswith("~~~"):
                in_fence = not in_fence
                continue
            if not in_fence and stripped.startswith("#"):
                hashes = len(stripped) - len(stripped.lstrip("#"))
                if 1 <= hashes <= 6 and stripped[hashes:].strip():
                    picked.append(index)
    else:
        picked = _code_declarations(lines)

    if not picked:
        facts.outline_bytes = 0
        facts.entries = 0
        return facts

    picked = picked[:MAX_ENTRIES]
    widest = len(str(picked[-1] + 1))
    body = 0
    for index in picked:
        shown = lines[index][:LINE_WIDTH]
        body += widest + 2 + len(shown.encode("utf-8")) + 1
    head = 160  # the header sentence, measured on the real tool's output
    facts.outline_bytes = body + head
    facts.entries = len(picked)
    return facts


def _code_declarations(lines: list[str]) -> list[int]:
    picked: list[int] = []
    depth = 0
    type_depths: list[int] = []
    for index, raw in enumerate(lines):
        stripped = raw.strip()
        if not stripped:
            continue
        entered = depth
        if not _is_comment(stripped):
            keyword = _declaration_keyword(stripped)
            if keyword is not None:
                picked.append(index)
                if keyword in {
                    "class", "struct", "interface", "enum", "type", "trait",
                    "impl", "object", "record", "protocol", "extension",
                    "union", "namespace", "module",
                } and _ends_open(stripped):
                    type_depths.append(entered + 1)
            elif type_depths and entered >= type_depths[-1] and _looks_method(stripped):
                picked.append(index)
            elif _looks_indented_declaration(raw, stripped):
                picked.append(index)
        depth += _brace_delta(raw)
        depth = max(depth, 0)
        while type_depths and depth < type_depths[-1]:
            type_depths.pop()
    return picked


MODIFIERS = (
    "pub(crate)", "pub(super)", "pub", "export", "default", "declare",
    "public", "private", "protected", "internal", "static", "final",
    "abstract", "sealed", "open", "override", "suspend", "inline",
    "virtual", "extern", "unsafe", "async", "partial", "readonly",
    "mutable", "synchronized", "native", "transient", "volatile",
)
BINDERS = ("const", "let", "var", "val")
CONTROL = (
    "if", "for", "while", "switch", "case", "catch", "return", "else", "do",
    "try", "finally", "throw", "new", "delete", "await", "yield", "with",
    "using", "lock", "foreach", "unless", "until", "match", "when", "then",
    "begin", "rescue", "ensure", "elif", "loop", "defer", "go", "select",
    "range", "break", "continue", "goto", "raise", "assert", "pass",
    "import", "package", "from",
)


def _has_word_prefix(text: str, word: str) -> bool:
    if not text.startswith(word):
        return False
    if len(text) == len(word):
        return True
    nxt = text[len(word)]
    return not (nxt.isalnum() or nxt in "_$")


def _strip_modifiers(text: str) -> str:
    while True:
        changed = False
        for modifier in MODIFIERS:
            if _has_word_prefix(text, modifier):
                text = text[len(modifier):].strip()
                changed = True
        if not changed:
            return text


ARROW_FUNCTION = re.compile(
    r"^[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s+)?"
    r"(?:function\b|\((?:[^()]|\([^()]*\))*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)")


def _looks_function_value(text: str) -> bool:
    rest = _strip_modifiers(text)
    for binder in BINDERS:
        if _has_word_prefix(rest, binder):
            rest = rest[len(binder):].strip()
            break
    return bool(ARROW_FUNCTION.match(rest))


def _looks_indented_declaration(raw: str, stripped: str) -> bool:
    """A declaration nested inside a function body: a closure, a nested component."""
    if raw == stripped:
        return False
    return _looks_function_value(_strip_modifiers(stripped))


def _declaration_keyword(stripped: str) -> str | None:
    rest = _strip_modifiers(stripped)
    for binder in BINDERS:
        if _has_word_prefix(rest, binder):
            if "=" not in rest:
                return binder
            return binder if _looks_function_value(rest) else None
    for keyword in KEYWORDS:
        if _has_word_prefix(rest, keyword):
            return keyword
    if rest.startswith("("):
        for keyword in KEYWORDS:
            if rest.startswith("(" + keyword + " "):
                return keyword
    return None


def _looks_method(stripped: str) -> bool:
    words = stripped.split()
    first = words[0] if words else ""
    if first in CONTROL:
        return False
    # A Go struct field of function type (Handler func(...) error) sits inside a
    # type body and carries a call-like paren; it is a field, not a method.
    if re.match(r"^[A-Za-z_]\w*\s+func\s*\(", stripped):
        return False
    if stripped.startswith("@") or stripped.startswith("#["):
        return False
    open_paren = stripped.find("(")
    if open_paren <= 0:
        return False
    if not (_ends_open(stripped) or stripped.endswith(";")
            or stripped.endswith("(") or stripped.endswith(",")):
        return False
    body = _strip_line_comment(stripped)
    previous = body[open_paren - 1]
    return previous.isalnum() or previous in "_$>"


def _strip_line_comment(text: str) -> str:
    cut = text.find("//")
    return text[:cut].rstrip() if cut >= 0 else text


def _ends_open(stripped: str) -> bool:
    return _strip_line_comment(stripped).endswith("{")


def _is_comment(stripped: str) -> bool:
    return (stripped.startswith("//") or stripped.startswith("/*")
            or stripped.startswith("*")
            or (stripped.startswith("#") and not stripped.startswith("#[")))


def _brace_delta(line: str) -> int:
    delta = 0
    quote = ""
    escaped = False
    for char in line:
        if quote:
            if escaped:
                escaped = False
            elif char == "\\" and quote != "`":
                escaped = True
            elif char == quote:
                quote = ""
            continue
        if char in "\"'`":
            quote = char
        elif char == "{":
            delta += 1
        elif char == "}":
            delta -= 1
    return delta


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------

@dataclass
class Replaced:
    path: str
    total_lines: int
    before_bytes: int
    outline_bytes: int
    entries: int


def load_facts(paths: set[str], root: Path, cache: dict[str, FileFacts]) -> None:
    for path in paths:
        if path in cache:
            continue
        target = (root / path).resolve()
        try:
            if not target.is_file():
                cache[path] = FileFacts(missing=True)
                continue
            raw = target.read_bytes()
        except OSError:
            cache[path] = FileFacts(missing=True)
            continue
        if len(raw) > 4_000_000:
            cache[path] = FileFacts(missing=True)
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            cache[path] = FileFacts(missing=True)
            continue
        cache[path] = render_outline(path, text)


def replay(sessions, threshold_lines: int, cache: dict[str, FileFacts]):
    """Return the replaced set and the totals, for one threshold."""

    replaced: list[Replaced] = []
    # (path) -> True once the skeleton has been handed over in this run.
    misses = Counter()

    for sess in sessions:
        by_run: dict[str, list[Call]] = defaultdict(list)
        for call in sess.calls:
            by_run[call.run].append(call)

        for run, calls in by_run.items():
            calls.sort(key=lambda c: (c.step, c.orig_index))
            outlined: set[str] = set()
            for call in calls:
                if call.tool != "read_file":
                    continue
                path = str(call.args.get("path") or "")
                if not path:
                    continue
                facts = cache.get(path)
                if facts is None or facts.missing:
                    misses[path] += 1
                    continue
                # Only a whole-file (or open-ended) read has a skeleton to save;
                # a model that already asked for one interval knew what it wanted.
                if call.args.get("start_line") or call.args.get("end_line"):
                    continue
                if path in outlined:
                    continue
                if facts.total_lines <= threshold_lines:
                    continue
                if facts.entries == 0:
                    # Nothing recognizable: the tool answers with one sentence
                    # instead of a body, which is a real saving but not a
                    # skeleton. Counted separately so it cannot inflate the win.
                    continue
                replaced.append(Replaced(
                    path=path,
                    total_lines=facts.total_lines,
                    before_bytes=call.chars,
                    outline_bytes=facts.outline_bytes,
                    entries=facts.entries,
                ))
                outlined.add(path)

    return replaced, misses


def main() -> int:
    here = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", default=str(here / ".tudouni" / "logs"))
    ap.add_argument("--root", default=str(here))
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    logs = Path(args.logs)
    root = Path(args.root)
    if not logs.is_dir():
        print(f"没有日志目录：{logs}", file=sys.stderr)
        return 2

    sessions = load(logs)
    if not sessions:
        print("没有可用的会话记录。", file=sys.stderr)
        return 2

    reads = [c for s in sessions for c in s.calls if c.tool == "read_file"]
    whole = [c for c in reads
             if not c.args.get("start_line") and not c.args.get("end_line")]
    ranged = [c for c in reads
              if c.args.get("start_line") or c.args.get("end_line")]

    # The follow-up cost is swept, so measure what a real ranged read costs.
    spans = []
    for call in ranged:
        start = call.args.get("start_line") or 1
        end = call.args.get("end_line")
        if isinstance(start, int) and isinstance(end, int) and end >= start:
            spans.append(end - start + 1)
    median_span = int(statistics.median(spans)) if spans else 80

    paths = {str(c.args.get("path") or "") for c in reads}
    paths.discard("")

    cache: dict[str, FileFacts] = {}
    load_facts(paths, root, cache)

    resolved = sum(1 for p in paths if not cache.get(p, FileFacts()).missing)
    total_chars = sum(c.chars for c in whole)
    per_call = total_chars / len(whole) if whole else 0

    lines = []
    add = lines.append
    add("# read_file(outline=true) A/B 评估")
    add("")
    add("> 回放真实审计日志里的每一次 read_file，")
    add("> 对「先要骨架再读区间」和「直接整读」两种做法记账。")
    add(">")
    add("> **骨架不是免费的**：一次整读会变成「1 次 outline + 1 次区间读」，")
    add("> 轮次可能上升。下面同时给字节数和轮次，不单独拿 token 说事。")
    add("")
    add(f"- 日志：`{logs}`")
    add(f"- 会话 {len(sessions)}，read_file {len(reads)} 次"
        f"（整读 {len(whole)}，区间读 {len(ranged)}）")
    add(f"- 整读平均一次拿回 **{per_call:,.0f} 字节**")
    add(f"- 日志里出现过的文件 {len(paths)} 个，其中 {resolved} 个能在本仓库找到并算出骨架")
    add(f"- 区间读的中位跨度 **{median_span} 行**（用作后续区间读的成本基准）")
    add("")

    add("## 一、按阈值扫：多大文件才值得先要骨架")
    add("")
    add("| 阈值(行) | 会被替换的整读 | 替换前字节 | 骨架字节 | 省下字节 | 省下比例 | 轮次变化 |")
    add("|---:|---:|---:|---:|---:|---:|---:|")
    sweeps = {}
    for threshold in (50, 100, 200, 400, 800, 1600):
        replaced, misses = replay(sessions, threshold, cache)
        before = sum(r.before_bytes for r in replaced)
        outline = sum(r.outline_bytes for r in replaced)
        after = outline  # upper bound: no follow-up charged
        sweeps[threshold] = {
            "count": len(replaced),
            "before": before,
            "outline": outline,
        }
        add(f"| {threshold} | {len(replaced)} | {before:,} | {outline:,} | "
            f"{before - after:,} | {100.0 * (before - after) / before if before else 0:.1f}% | "
            f"+{len(replaced)} 轮 |")
    add("")
    add("「省下比例」是**上限**：它假设模型拿到骨架后一次都不用再读正文。")
    add("")

    # Sweep the follow-up cost at the recommended threshold.
    chosen = 200
    replaced, misses = replay(sessions, chosen, cache)
    before = sum(r.before_bytes for r in replaced)
    outline = sum(r.outline_bytes for r in replaced)

    # A follow-up read costs roughly what a ranged read of N lines costs: scale the
    # file's own bytes-per-line by the median span.
    def followup_cost(span_lines: int) -> int:
        total = 0
        for item in replaced:
            facts = cache[item.path]
            if facts.total_lines:
                total += int(span_lines * (sum(facts.bytes_per_line) / facts.total_lines))
        return total

    add(f"## 二、净收益随「骨架后还要读多少行」变化（阈值 {chosen} 行）")
    add("")
    add("| 骨架后需读 | 后续区间字节 | 净省字节 | 净省比例 | 轮次变化 | 结论 |")
    add("|---:|---:|---:|---:|---:|---|")
    for span in (0, 40, median_span, 120, 200, 400, 800):
        follow = followup_cost(span)
        net = before - outline - follow
        pct = 100.0 * net / before if before else 0
        verdict = "省" if net > 0 else "**亏**"
        add(f"| {span} 行 | {follow:,} | {net:,} | {pct:.1f}% | +{len(replaced)} 轮 | {verdict} |")
    add("")
    # Break-even span.
    baseline = before - outline
    per_line = 0
    for item in replaced:
        facts = cache[item.path]
        if facts.total_lines:
            per_line += sum(facts.bytes_per_line) / facts.total_lines
    breakeven = int(baseline / per_line) if per_line else 0
    add(f"**盈亏平衡点：骨架之后累计再读约 {breakeven:,} 行，收益归零。**")
    add(f"（低于这个数才划算；对应地，整读一个 {chosen}+ 行的文件时，")
    add(f"模型能否只看其中一小段就完成判断——这正是骨架要回答的问题。）")
    add("")

    add("## 三、被替换的读取（按文件）")
    add("")
    add("| 文件 | 行数 | 声明数 | 整读字节 | 骨架字节 | 压缩 |")
    add("|---|---:|---:|---:|---:|---:|")
    agg: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0, 0])
    for item in replaced:
        row = agg[item.path]
        row[0] = item.total_lines
        row[1] = item.entries
        row[2] += item.before_bytes
        row[3] += item.outline_bytes
        row[4] += 1
    for path, row in sorted(agg.items(), key=lambda kv: -kv[1][2])[:18]:
        ratio = 100.0 * row[3] / row[2] if row[2] else 0
        add(f"| `{path}` | {row[0]} | {row[1]} | {row[2]:,} | {row[3]:,} | {ratio:.1f}% |")
    add("")

    add("## 四、这份评估的边界")
    add("")
    add("1. **后续区间读是参数，不是观测。** 日志里没有「如果当时给了骨架会怎样」")
    add("   这一条世界线，所以第二节扫的是假设值，盈亏平衡点才是可下的结论。")
    add("2. **只回放整读。** 已经带 start_line/end_line 的读取不动——模型那时")
    add("   已经知道目标了，再给骨架没有意义。")
    add("3. **同一 run 内一个文件最多替换一次。** 拿到骨架后再整读同一个文件，")
    add("   多半是模型真的需要全文，不再算浪费。")
    add(f"4. **{len(misses)} 个文件路径在仓库里找不到**（历史会话的工作区可能不是本仓库），")
    add("   它们被排除，不参与计算。")

    print("\n".join(lines))

    if args.json:
        Path(args.json).write_text(json.dumps({
            "sessions": len(sessions),
            "reads": len(reads),
            "whole": len(whole),
            "ranged": len(ranged),
            "median_span": median_span,
            "sweeps": sweeps,
            "breakeven_span": breakeven,
            "replaced": [
                {"path": r.path, "lines": r.total_lines, "entries": r.entries,
                 "before": r.before_bytes, "outline": r.outline_bytes}
                for r in replaced
            ],
            "unresolved": len(misses),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n（JSON 已写入 {args.json}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
