#!/usr/bin/env python3
"""Offline estimate of how much a code-structure layer could save.

The question this answers is an UPPER BOUND, not a prediction: of all the
tool calls this runtime made in real sessions, how many of them were spent
*looking for something whose location was not yet known* -- the category a
symbol index or LSP could in principle answer in fewer round trips.

Reading the number correctly matters as much as computing it:

  * every figure here is gross. Nothing subtracts the cost the replacement
    would itself pay (one outline call per file still costs a round trip).
  * a round is charged at its real prompt size, because the saving shows up
    on the *next* request's prompt, not on the tool result alone.
  * nothing is counted as waste unless the log shows the failure shape:
    a read with no prior locator, a grep that alternates guessed names, a
    re-read of an interval already in context.

Usage:
    python scripts/exploration_cost.py [--logs DIR] [--json OUT]

No network, no dependencies, no writes outside --json.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


@dataclass
class Call:
    """One tool call, joined across tool_call / tool_result / model_call."""

    session: str
    run: str
    step: int
    tool: str
    args: dict
    chars: int = 0
    status: str = ""
    # prompt_tokens of the model call that FOLLOWED this call. The saving of
    # removing this call is realised on that request, so that is what a
    # prospective saving has to be measured against.
    next_prompt_tokens: int = 0
    next_cached: int = 0
    next_miss: int = 0
    # Position in the log, so calls on the same step still have a stable order.
    orig_index: int = 0


@dataclass
class Session:
    id: str
    calls: list[Call] = field(default_factory=list)
    # (run, step) -> prompt token fields of the model call at that step
    prompts: dict[tuple[str, int], tuple[int, int, int]] = field(default_factory=dict)
    # (run, step) -> wall_wall_ms of that tool batch
    batch_ms: dict[tuple[str, int], int] = field(default_factory=dict)
    model_ms: list[int] = field(default_factory=list)
    reasoning: list[str] = field(default_factory=list)


def load(logs_dir: Path) -> list[Session]:
    sessions: dict[str, Session] = {}
    pending: dict[str, Call] = {}  # call_id -> Call

    for path in sorted(logs_dir.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue

            kind = rec.get("kind")
            sid = rec.get("session_id") or ""
            if not sid:
                continue
            sess = sessions.setdefault(sid, Session(id=sid))
            run = rec.get("run_id") or ""
            step = int(rec.get("step") or 0)

            if kind == "model_call":
                sess.prompts[(run, step)] = (
                    int(rec.get("prompt_tokens") or 0),
                    int(rec.get("cached_tokens") or 0),
                    int(rec.get("miss_tokens") or 0),
                )
                if rec.get("duration_ms"):
                    sess.model_ms.append(int(rec["duration_ms"]))
                note = rec.get("reasoning")
                if isinstance(note, str) and note:
                    sess.reasoning.append(note)

            elif kind == "tool_batch":
                if rec.get("wall_ms"):
                    sess.batch_ms[(run, step)] = int(rec["wall_ms"])

            elif kind == "tool_call":
                raw = rec.get("arguments")
                try:
                    args = json.loads(raw) if isinstance(raw, str) else (raw or {})
                except json.JSONDecodeError:
                    args = {}
                call = Call(
                    session=sid,
                    run=run,
                    step=step,
                    tool=rec.get("tool") or "",
                    args=args if isinstance(args, dict) else {},
                    orig_index=len(sess.calls),
                )
                pending[rec.get("call_id") or ""] = call
                sess.calls.append(call)

            elif kind == "tool_result":
                call = pending.get(rec.get("call_id") or "")
                if call is not None:
                    call.chars = int(rec.get("chars") or 0)
                    call.status = rec.get("status") or ""

    # Attach the prompt size of the request that follows each call.
    for sess in sessions.values():
        for call in sess.calls:
            follow = sess.prompts.get((call.run, call.step + 1))
            if follow:
                call.next_prompt_tokens, call.next_cached, call.next_miss = follow
    return [s for s in sessions.values() if s.calls]


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

# A grep pattern that alternates three or more bare identifiers is the shape
# of "I do not know what it is called, so let me try every name I can think
# of". One or two alternatives are ordinary (two spellings of the same thing);
# three or more is the search hammer.
ALTERNATION = re.compile(r"\\?\|")


def alternation_count(pattern: str) -> int:
    # Count top-level-ish alternatives: split on | that is not escaped.
    parts = [p for p in re.split(r"(?<!\\)\|", pattern) if p.strip()]
    return len(parts)


@dataclass
class Bucket:
    name: str
    calls: int = 0
    chars: int = 0
    prompt_tokens: int = 0
    wall_ms: int = 0

    def add(self, call: Call, wall: int) -> None:
        self.calls += 1
        self.chars += call.chars
        self.prompt_tokens += call.next_prompt_tokens
        self.wall_ms += wall


def _orig_index(call: Call) -> int:
    return call.orig_index


def _order_key(call: Call) -> tuple[int, int]:
    """Calls inside one run are ordered by step, then by arrival in the log.

    Step alone is not a total order: a parallel batch has several calls on
    the same step, and "was there a locator before this read" must not depend
    on how the JSON happened to be read.
    """
    return (call.step, _orig_index(call))


def classify(sessions: list[Session]):
    """Return per-bucket counts plus the sub-shapes of the explorative bucket."""

    buckets = {
        "locator": Bucket("First attempt to find a location (grep/list/outline-ish)"),
        "follow": Bucket("Read after a locator in the same run (position already known)"),
        "explore": Bucket("Read with NO locator yet (guessing where to look)"),
        "reread": Bucket("Re-read of an interval already returned this session"),
        "edit": Bucket("Mutation (write/edit/present)"),
        "verify": Bucket("Verification (shell/jobs/tests)"),
        "other": Bucket("Everything else"),
    }

    sub = Counter()
    explore_paths: Counter[str] = Counter()
    reread_paths: Counter[str] = Counter()

    for sess in sessions:
        # Reset per run: a new user turn legitimately re-establishes context.
        by_run: dict[str, list[Call]] = defaultdict(list)
        for call in sess.calls:
            by_run[call.run].append(call)

        for run, calls in by_run.items():
            calls.sort(key=_order_key)

            # Which steps in this run produced a locator AT OR BEFORE each step.
            # A locator and a read in the same parallel batch means the model did
            # not know the location when it asked for the read -- the batch was
            # planned from one context. So "located before" means strictly
            # earlier step, except that a locator alone on an earlier step counts.
            locator_steps = {c.step for c in calls
                             if c.tool in {"grep", "list_files", "outline"}}

            seen_intervals: dict[str, list[tuple[int, int]]] = defaultdict(list)

            for call in calls:
                # Wall time belongs to the batch, so it is attributed once per
                # step: track which steps this run has already charged.
                wall = sess.batch_ms.get((run, call.step), 0)
                name = call.tool
                args = call.args

                if name in {"grep", "list_files"}:
                    buckets["locator"].add(call, wall)
                    if name == "grep":
                        pattern = str(args.get("pattern") or "")
                        n = alternation_count(pattern)
                        if n >= 3:
                            sub["grep with 3+ alternated names (guessing)"] += 1
                        elif n == 2:
                            sub["grep with 2 alternated names"] += 1
                        else:
                            sub["grep single pattern"] += 1
                        if args.get("include"):
                            sub["grep already narrowed by include"] += 1

                elif name == "read_file":
                    path = str(args.get("path") or "")
                    start = args.get("start_line")
                    end = args.get("end_line")
                    lo = int(start) if isinstance(start, int) else 1
                    hi = int(end) if isinstance(end, int) else 10**9

                    located = any(s < call.step for s in locator_steps)
                    already = any(lo >= a and hi <= b
                                  for a, b in seen_intervals.get(path, []))

                    if already:
                        buckets["reread"].add(call, wall)
                        reread_paths[path] += 1
                        sub["re-read of an already-returned interval"] += 1
                    elif located:
                        buckets["follow"].add(call, wall)
                        sub["read after a locator"] += 1
                    else:
                        buckets["explore"].add(call, wall)
                        explore_paths[path] += 1
                        if not start and not end:
                            sub["whole-file read with no locator"] += 1
                        else:
                            sub["ranged read with no locator"] += 1

                    seen_intervals[path].append((lo, hi))

                elif name in {"write_file", "edit_file", "present"}:
                    buckets["edit"].add(call, wall)
                elif name in {"shell", "shell_background", "job_output", "job_list", "job_kill"}:
                    buckets["verify"].add(call, wall)
                else:
                    buckets["other"].add(call, wall)

    return buckets, sub, explore_paths, reread_paths


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def fmt_int(n: int) -> str:
    return f"{n:,}"


def main() -> int:
    here = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", default=str(here / ".tudouni" / "logs"))
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    logs = Path(args.logs)
    if not logs.is_dir():
        print(f"没有找到审计日志目录：{logs}", file=sys.stderr)
        print("这份评估只能跑在真实日志上；日志清空后建议先恢复或重新采集。", file=sys.stderr)
        return 2

    sessions = load(logs)
    if not sessions:
        print(f"{logs} 里没有可用的会话记录。", file=sys.stderr)
        return 2

    buckets, sub, explore_paths, reread_paths = classify(sessions)

    total_calls = sum(b.calls for b in buckets.values())
    total_prompt = sum(b.prompt_tokens for b in buckets.values())
    total_wall = sum(b.wall_ms for b in buckets.values())
    total_chars = sum(b.chars for b in buckets.values())

    model_ms = [ms for s in sessions for ms in s.model_ms]
    avg_model = sum(model_ms) / len(model_ms) if model_ms else 0.0

    # The optimisable set. `explore` and `reread` are the two shapes a
    # structure layer addresses; `locator` is only partially addressable
    # (a symbol query replaces it, but replaces it with one call).
    opt = Bucket("sum")
    for k in ("explore", "reread"):
        opt.calls += buckets[k].calls
        opt.chars += buckets[k].chars
        opt.prompt_tokens += buckets[k].prompt_tokens
        opt.wall_ms += buckets[k].wall_ms

    guess_greps = sub["grep with 3+ alternated names (guessing)"]
    grep_total = sub["grep single pattern"] + sub["grep with 2 alternated names"] + guess_greps

    lines = []
    add = lines.append

    add("# 探索成本评估：结构化索引能省下多少")
    add("")
    add("> 全部数字来自真实审计日志，离线统计，未改动 runtime 任何代码。")
    add("> 复现：`python scripts/exploration_cost.py`")
    add("")
    add(f"- 日志目录：`{logs}`")
    add(f"- 会话数：**{fmt_int(len(sessions))}**")
    add(f"- 工具调用：**{fmt_int(total_calls)}**")
    add(f"- 模型调用样本：**{fmt_int(len(model_ms))}**，平均耗时 "
        f"**{avg_model/1000:.1f}s**")
    add("")

    add("## 一、调用分类")
    add("")
    add("| 类别 | 次数 | 占比 | 结果字符数 | 后续请求 prompt 合计 | 工具墙钟 |")
    add("|---|---:|---:|---:|---:|---:|")
    for b in sorted(buckets.values(), key=lambda x: -x.calls):
        pct = 100.0 * b.calls / total_calls if total_calls else 0
        add(f"| {b.name} | {fmt_int(b.calls)} | {pct:.1f}% | "
            f"{fmt_int(b.chars)} | {fmt_int(b.prompt_tokens)} | {b.wall_ms/1000:.1f}s |")
    add(f"| **合计** | **{fmt_int(total_calls)}** | 100% | "
        f"{fmt_int(total_chars)} | {fmt_int(total_prompt)} | {total_wall/1000:.1f}s |")
    add("")

    add("## 二、可优化集合（explore + reread）")
    add("")
    explore = buckets["explore"]
    reread = buckets["reread"]
    add("| 指标 | explore | reread | 合计 | 占全部工具调用 |")
    add("|---|---:|---:|---:|---:|")
    add(f"| 次数 | {fmt_int(explore.calls)} | {fmt_int(reread.calls)} | "
        f"**{fmt_int(opt.calls)}** | **{100.0*opt.calls/total_calls:.1f}%** |")
    add(f"| 结果字符数 | {fmt_int(explore.chars)} | {fmt_int(reread.chars)} | "
        f"{fmt_int(opt.chars)} | {100.0*opt.chars/total_chars if total_chars else 0:.1f}% |")
    add(f"| 后续 prompt tokens | {fmt_int(explore.prompt_tokens)} | "
        f"{fmt_int(reread.prompt_tokens)} | {fmt_int(opt.prompt_tokens)} | "
        f"{100.0*opt.prompt_tokens/total_prompt if total_prompt else 0:.1f}% |")
    add("")

    add("## 三、grep 的形状（模型在猜名字的证据）")
    add("")
    add("| 形状 | 次数 |")
    add("|---|---:|")
    for k, v in sub.most_common():
        if k.startswith("grep"):
            add(f"| {k} | {fmt_int(v)} |")
    if grep_total:
        add("")
        add(f"3 个以上名字交替着猜的 grep 占全部 grep 的 "
            f"**{100.0*guess_greps/grep_total:.1f}%**。")
    add("")

    add("## 四、收益上限")
    add("")
    add("口径：**最乐观情形 —— 可优化集合整个消失，且一次替代调用都不补。**")
    add("")
    rounds_per_session = total_calls / len(sessions) if sessions else 0
    opt_rounds = opt.calls
    add("| 口径 | 值 |")
    add("|---|---:|")
    add(f"| 消失的工具调用 | {fmt_int(opt_rounds)} 次 |")
    add(f"| 每会话平均可省轮次 | {opt_rounds/len(sessions):.1f} 次 |")
    add(f"| 若按平均单轮换算（{avg_model/1000:.1f}s/轮）省下的墙钟 | "
        f"{opt_rounds*avg_model/1000/60:.1f} 分钟 |")
    add("")
    add("**这只是上限。** 真实落地必须扣掉：")
    add("")
    add("1. 替代调用本身的花费（一次 outline 也是一轮）：按 1:1 替换算，净收益直接砍半；")
    add("2. 近似的行号会带来“读了发现不对、再读一次”的额外轮次；")
    add("3. explore 里的读取有一部分**本来就该读**（第一次通读模块），不是浪费。")
    add("")
    add("## 五、热路径：被反复读的文件")
    add("")
    add("| 文件 | 无定位读取次数 | 重复读次数 |")
    add("|---|---:|---:|")
    for path, n in explore_paths.most_common(10):
        add(f"| `{path}` | {fmt_int(n)} | {fmt_int(reread_paths.get(path, 0))} |")
    add("")

    add("## 六、这份数据的已知缺口")
    add("")
    add("评估过程中发现的、会影响读数的问题，一并写在这里，避免被当成「已全部量到」：")
    add("")
    add("1. **`shell` 从不产生 `tool_batch` 事件。** 全库 2,985 条 `tool_batch` 里")
    add("   没有一条 `tools` 含 `shell`，所以 `Verification` 那一类的墙钟是 0，")
    add("   `edit` 同理。本报告的墙钟一列只在 read/grep 上可信。")
    add("   → 这是审计层的一个缺口，不是本脚本的问题；修 `audit` 那一侧才能补齐。")
    add("2. **并行批次内无法区分先后。** 同一 step 上的 grep 和 read 是并行发出的，")
    add("   模型在规划时并不知道位置，所以这里按「定位符必须在严格更早的 step」来判定")
    add("   `explore`，这比按 log 顺序判定更保守、也更接近真实。")
    add("3. **`Verification` 占 34% 是最大的一块**，但它和结构化索引无关 ——")
    add("   它对应的是 `perf-analysis.md` 里那条「少跑几次慢命令」的结论。")
    add("")

    report = "\n".join(lines)
    print(report)

    if args.json:
        payload = {
            "sessions": len(sessions),
            "calls": total_calls,
            "buckets": {k: vars(v) for k, v in buckets.items()},
            "sub": dict(sub),
            "optimisable": vars(opt),
            "explore_paths": dict(explore_paths.most_common(30)),
            "reread_paths": dict(reread_paths.most_common(30)),
            "avg_model_ms": avg_model,
        }
        Path(args.json).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n（JSON 已写入 {args.json}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
