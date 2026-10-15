"""Render PNG charts for a bench run from its summary.json and run.json.

    python scripts/bench/charts.py --run lumen-main

Writes data/bench/runs/<run>/charts/*.png. Needs matplotlib (pip install matplotlib).
"""

import argparse
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NAME = {"embed": "stealth-01", "llm": "gpt-6-luna"}
COLOR = {"embed": "#2F6F9F", "llm": "#C2703D"}
INK = "#222222"
MUTED = "#666666"
GRID = "#E3E3E3"
OUTCOME_COLORS = ["#4F7F5F", "#C2703D", "#2F6F9F", "#9A9A9A"]


def load(run: str):
    run_dir = ROOT / "data" / "bench" / "runs" / run
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf8"))
    meta = json.loads((run_dir / "run.json").read_text(encoding="utf8"))
    return run_dir, summary, meta


def estimate_stealth_tokens(questions_file: str) -> tuple[int, int]:
    """Same rule as the report: about 4 characters per token, rounded up per question."""
    total, count = 0, 0
    for line in Path(questions_file).read_text(encoding="utf8").splitlines():
        if not line.strip():
            continue
        text = json.loads(line)["text"]
        total += math.ceil(len(text) / 4)
        count += 1
    return total, count


def style_axes(ax, title, source, xlabel=None, ylabel=None):
    ax.set_title(title, loc="left", fontsize=13, fontweight="bold", color=INK, pad=14)
    if xlabel:
        ax.set_xlabel(xlabel, color=INK)
    if ylabel:
        ax.set_ylabel(ylabel, color=INK)
    ax.tick_params(colors=INK)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(MUTED)
    ax.spines["bottom"].set_color(MUTED)
    ax.grid(axis="x" if ax.name == "barh" else "y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.figure.text(0.01, 0.01, source, fontsize=8, color=MUTED, ha="left", va="bottom")


def save(fig, out_dir: Path, name: str):
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    path = out_dir / f"{name}.png"
    fig.savefig(path, dpi=150, facecolor="white")
    plt.close(fig)
    return path


def chart_accuracy(summary, out_dir, source):
    fig, ax = plt.subplots(figsize=(7, 5))
    arms = ["embed", "llm"]
    acc = [summary["arms"][a]["accuracy"]["acc"] * 100 for a in arms]
    lo = [summary["arms"][a]["accuracy"]["ci"][0] * 100 for a in arms]
    hi = [summary["arms"][a]["accuracy"]["ci"][1] * 100 for a in arms]
    err = [[acc[i] - lo[i] for i in range(2)], [hi[i] - acc[i] for i in range(2)]]
    bars = ax.bar([NAME[a] for a in arms], acc, color=[COLOR[a] for a in arms], width=0.55, yerr=err, capsize=6, ecolor=INK)
    for bar, value, h in zip(bars, acc, hi):
        ax.text(bar.get_x() + bar.get_width() / 2, h + 2, f"{value:.1f}%", ha="center", va="bottom", fontsize=12, color=INK)
    ax.set_ylim(0, 100)
    style_axes(ax, "Intent accuracy: stealth-01 vs gpt-6-luna", source, ylabel="Exact-match accuracy (%)")
    ax.text(0.99, 0.97, "Bars: accuracy. Whiskers: 95% Wilson CI.", transform=ax.transAxes, ha="right", va="top", fontsize=8, color=MUTED)
    return save(fig, out_dir, "01_accuracy_overall")


def chart_outcomes(summary, out_dir, source):
    p = summary["paired"]
    n = p["n"]
    stealth_only = p["embedOnlyCorrect"]
    gpt_only = p["llmOnlyCorrect"]
    both_right = p["embedCorrect"] - stealth_only
    both_wrong = n - both_right - stealth_only - gpt_only
    parts = [
        ("Both right", both_right),
        ("gpt-6-luna only", gpt_only),
        ("stealth-01 only", stealth_only),
        ("Both wrong", both_wrong),
    ]
    fig, ax = plt.subplots(figsize=(10, 2.8))
    left = 0
    for (label, value), color in zip(parts, OUTCOME_COLORS):
        ax.barh([0], [value], left=left, color=color, height=0.5, label=f"{label}: {value}")
        if value >= 40:
            ax.text(left + value / 2, 0, str(value), ha="center", va="center", color="white", fontsize=11, fontweight="bold")
        left += value
    ax.set_xlim(0, n)
    ax.set_yticks([])
    ax.set_xlabel(f"Questions (n = {n})", color=INK)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.32), ncol=4, frameon=False, fontsize=9)
    style_axes(ax, "Where the two arms disagree", source)
    ax.grid(False)
    return save(fig, out_dir, "02_outcomes")


def grouped_bars(ax, categories, series, value_fmt="{:.1f}%"):
    x = np.arange(len(categories))
    width = 0.38
    for i, (arm, values) in enumerate(series):
        offset = (i - 0.5) * width
        bars = ax.bar(x + offset, values, width, color=COLOR[arm], label=NAME[arm])
        for bar, v in zip(bars, values):
            ax.text(bar.get_x() + bar.get_width() / 2, v + 1, value_fmt.format(v), ha="center", va="bottom", fontsize=7.5, color=INK)
    ax.set_xticks(x)
    ax.set_xticklabels(categories, fontsize=9)
    ax.set_ylim(0, 110)
    ax.legend(frameon=False, loc="upper right", ncol=2)


def chart_depth(summary, out_dir, source):
    keys = ["depth 1", "depth 2", "depth 3", "out of scope"]
    labels = ["Depth 1\n(top-level)", "Depth 2\n(sub-intent)", "Depth 3\n(follow-up)", "Out of scope\n(correct refusal)"]
    fig, ax = plt.subplots(figsize=(9, 5))
    series = [(a, [summary["byDepth"][a][k]["acc"] * 100 for k in keys]) for a in ["embed", "llm"]]
    grouped_bars(ax, labels, series)
    style_axes(ax, "Accuracy by expected intent depth", source, ylabel="Exact-match accuracy (%)")
    return save(fig, out_dir, "03_accuracy_by_depth")


def pretty_style(key: str) -> str:
    return key.replace("_", "-").capitalize()


def chart_style(summary, out_dir, source):
    keys = sorted(summary["byStyle"]["embed"].keys())
    fig, ax = plt.subplots(figsize=(11, 5))
    series = [(a, [summary["byStyle"][a][k]["acc"] * 100 for k in keys]) for a in ["embed", "llm"]]
    grouped_bars(ax, [pretty_style(k) for k in keys], series, value_fmt="{:.0f}")
    style_axes(ax, "Accuracy by question style", source, ylabel="Exact-match accuracy (%)")
    return save(fig, out_dir, "04_accuracy_by_style")


def chart_area(summary, out_dir, source):
    keys = sorted(k for k in summary["byDomain"]["embed"].keys() if k != "(out of scope)")
    fig, ax = plt.subplots(figsize=(10, 8))
    y = np.arange(len(keys))
    height = 0.38
    for i, arm in enumerate(["embed", "llm"]):
        values = [summary["byDomain"][arm][k]["acc"] * 100 for k in keys]
        offset = (i - 0.5) * height
        bars = ax.barh(y + offset, values, height, color=COLOR[arm], label=NAME[arm])
        for bar, v in zip(bars, values):
            ax.text(v + 0.8, bar.get_y() + bar.get_height() / 2, f"{v:.0f}", va="center", fontsize=8, color=INK)
    ax.set_yticks(y)
    ax.set_yticklabels(keys, fontsize=9)
    ax.set_xlim(0, 105)
    ax.invert_yaxis()
    ax.set_xlabel("Exact-match accuracy (%)", color=INK)
    ax.legend(frameon=False, loc="lower right")
    style_axes(ax, "Accuracy by business area", source)
    ax.grid(axis="x", color=GRID, linewidth=0.8)
    ax.grid(axis="y", visible=False)
    return save(fig, out_dir, "05_accuracy_by_area")


def chart_threshold(summary, out_dir, source):
    sweep = summary["thresholdSweep"]
    x = [s["threshold"] for s in sweep]
    acc = [s["accuracy"] * 100 for s in sweep]
    fallback = [s["fallbackRate"] * 100 for s in sweep]
    configured = next(s["threshold"] for s in sweep if s["configured"])
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.plot(x, acc, marker="o", color=COLOR["embed"], linewidth=2, label="Accuracy (%)")
    ax.plot(x, fallback, marker="o", color="#B5483A", linewidth=2, label="In-scope false fallback (%)")
    ax.axvline(configured, color=MUTED, linestyle="--", linewidth=1)
    ax.text(configured, 96, f" configured {configured:.2f}", color=MUTED, fontsize=8, va="top")
    ax.set_ylim(0, 100)
    ax.set_xlabel("Raw similarity threshold for stealth-01", color=INK)
    ax.legend(frameon=False, loc="upper left")
    style_axes(ax, "stealth-01 threshold sweep (tuned on the test set, optimistic)", source, ylabel="%")
    return save(fig, out_dir, "06_threshold_sweep")


def chart_latency(summary, out_dir, source):
    fig, ax = plt.subplots(figsize=(7, 5))
    arms = ["embed", "llm"]
    x = np.arange(2)
    width = 0.36
    for i, (metric, label, alpha) in enumerate([("p50", "p50", 1.0), ("p95", "p95", 0.45)]):
        values = [summary["arms"][a]["latency"][metric] for a in arms]
        bars = ax.bar(x + (i - 0.5) * width, values, width, color=[COLOR[a] for a in arms], alpha=alpha, label=label)
        for bar, v in zip(bars, values):
            ax.text(bar.get_x() + bar.get_width() / 2, v, f"{v:,.0f}", ha="center", va="bottom", fontsize=9, color=INK)
    ax.set_xticks(x)
    ax.set_xticklabels([NAME[a] for a in arms])
    from matplotlib.patches import Patch

    ax.legend(
        handles=[Patch(facecolor="#555555", label="p50 (dark)"), Patch(facecolor="#555555", alpha=0.45, label="p95 (light)")],
        frameon=False,
        loc="upper left",
    )
    style_axes(ax, "Per-question latency", source, ylabel="Milliseconds")
    return save(fig, out_dir, "07_latency")


def chart_tokens(summary, stealth_tokens_per_msg, out_dir, source):
    tokens = summary["arms"]["llm"]["tokens"]
    n = summary["questions"]
    gpt_input = tokens["input"] / n
    gpt_cached = tokens["cached"] / n
    fig, ax = plt.subplots(figsize=(7, 5))
    labels = ["stealth-01\n(message embedding)", "gpt-6-luna\n(input)", "gpt-6-luna\n(of which cached)"]
    values = [stealth_tokens_per_msg, gpt_input, gpt_cached]
    bars = ax.bar(labels, values, color=[COLOR["embed"], COLOR["llm"], "#E0B08A"], width=0.55)
    ax.set_yscale("log")
    ax.set_ylim(10, 3e5)
    for bar, v in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, v * 1.1, f"{v:,.0f}", ha="center", va="bottom", fontsize=10, color=INK)
    ratio = gpt_input / stealth_tokens_per_msg
    ax.text(0.02, 0.97, f"About {ratio:,.0f}x fewer input tokens per message with stealth-01", transform=ax.transAxes, va="top", fontsize=10, color=INK)
    style_axes(ax, "Input tokens per customer message (log scale)", source, ylabel="Tokens per message")
    ax.grid(axis="x", visible=False)
    return save(fig, out_dir, "08_tokens_per_message")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    args = parser.parse_args()

    run_dir, summary, meta = load(args.run)
    out_dir = run_dir / "charts"
    out_dir.mkdir(parents=True, exist_ok=True)
    stealth_total, stealth_n = estimate_stealth_tokens(meta["questionsFile"])
    stealth_per_msg = stealth_total / stealth_n
    src = f"Source: data/bench/runs/{args.run} (summary.json). Bot: {meta['botName']}. {summary['questions']} questions."

    written = [
        chart_accuracy(summary, out_dir, src),
        chart_outcomes(summary, out_dir, src),
        chart_depth(summary, out_dir, src),
        chart_style(summary, out_dir, src),
        chart_area(summary, out_dir, src),
        chart_threshold(summary, out_dir, src),
        chart_latency(summary, out_dir, src),
        chart_tokens(summary, stealth_per_msg, out_dir, f"Source: data/bench/runs/{args.run}. stealth-01 tokens estimated at 4 chars/token."),
    ]
    for path in written:
        print(path)


if __name__ == "__main__":
    main()
