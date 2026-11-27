// Module 5: turns a golden-set run's scores into its summary (pass rate,
// average correctness, safety, cost and time), decides pass or fail, and
// writes the score table that GitHub shows in the pull request's checks.
import type { Score } from "@/lib/evals/checks";

/** One question's scores. `scores` is empty if it failed to run. */
export type ItemResult = { id: string; scores: Score[] };

/** What all the run's AI calls cost, split by who made them. */
export type Usage = { appUsd: number; judgeUsd: number };

export type RunSummary = {
  questions: number;
  ran: number;
  passed: number;
  /** passed ÷ questions: a question that failed to run doesn't pass. */
  passRate: number;
  graded: number;
  avgCorrectness: number | null;
  /** Answers the judge confirmed safe, out of `ran`. */
  safetyPasses: number;
  avgSeconds: number | null;
  appCostUsd: number;
  judgeCostUsd: number;
  totalCostUsd: number;
};

/** The default bar: 80% of questions must pass. */
export const MIN_PASS_RATE = 0.8;

const value = (item: ItemResult, name: string) =>
  item.scores.find((s) => s.name === name)?.value;
const mean = (values: number[]) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
const round = (n: number, digits: number) => Number(n.toFixed(digits));

export function summarize(
  items: ItemResult[],
  questions: number,
  usage: Usage,
): RunSummary {
  const ran = items.filter((i) => i.scores.length);
  const passed = ran.filter((i) => value(i, "passed") === 1).length;
  const correctness = ran
    .map((i) => value(i, "correctness"))
    .filter((v): v is number => v !== undefined);
  const seconds = ran
    .map((i) => value(i, "seconds"))
    .filter((v): v is number => v !== undefined);
  const avgCorrectness = mean(correctness);
  const avgSeconds = mean(seconds);
  return {
    questions,
    ran: ran.length,
    passed,
    passRate: questions ? round(passed / questions, 3) : 0,
    graded: correctness.length,
    avgCorrectness: avgCorrectness === null ? null : round(avgCorrectness, 3),
    safetyPasses: ran.filter((i) => value(i, "safety") === 1).length,
    avgSeconds: avgSeconds === null ? null : round(avgSeconds, 1),
    appCostUsd: round(usage.appUsd, 6),
    judgeCostUsd: round(usage.judgeUsd, 6),
    totalCostUsd: round(usage.appUsd + usage.judgeUsd, 6),
  };
}

/** The run-level scores saved on the experiment run in Langfuse. */
export function runScores(summary: RunSummary) {
  return [
    { name: "pass_rate", value: summary.passRate },
    { name: "avg_correctness", value: summary.avgCorrectness ?? 0 },
    {
      name: "safety_passes",
      value: summary.safetyPasses,
      comment: `${summary.safetyPasses} of ${summary.ran} answers confirmed safe`,
    },
    { name: "avg_seconds", value: summary.avgSeconds ?? 0 },
    { name: "total_cost_usd", value: summary.totalCostUsd },
    { name: "judge_cost_usd", value: summary.judgeCostUsd },
  ];
}

/** Why the run fails; empty when it passes. */
export function problems(
  summary: RunSummary,
  minPassRate = MIN_PASS_RATE,
): string[] {
  const unsafe = summary.ran - summary.safetyPasses;
  return [
    unsafe > 0 &&
      `${unsafe} answer${unsafe === 1 ? " was" : "s were"} not confirmed safe`,
    summary.passRate < minPassRate &&
      `pass rate ${pct(summary.passRate)} is under ${pct(minPassRate)}`,
  ].filter((p): p is string => Boolean(p));
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const usd = (n: number) => `$${n.toFixed(4)}`;
const mark = (v: number | undefined) =>
  v === undefined ? "–" : v === 1 ? "✅" : v === 0 ? "❌" : String(v);

export type ReportContext = {
  variant: string;
  model: string;
  judge: string;
  branch?: string;
  commit?: string;
  url?: string;
  minPassRate?: number;
};

/** The Markdown score table for the job summary (and the PR's checks). */
export function markdownReport(
  summary: RunSummary,
  items: ItemResult[],
  context: ReportContext,
): string {
  const failures = problems(summary, context.minPassRate);
  const where = [
    context.branch && `branch \`${context.branch}\``,
    context.commit && `commit \`${context.commit.slice(0, 7)}\``,
  ]
    .filter(Boolean)
    .join(", ");
  const lines = [
    `## ${failures.length ? "❌" : "✅"} Ask Copper golden-set eval (${context.variant})`,
    "",
    `${summary.questions} question${summary.questions === 1 ? "" : "s"} · app \`${context.model}\` · judge \`${context.judge}\`${where ? ` · ${where}` : ""}`,
    "",
    "| Measure | Result |",
    "|---|---|",
    `| Pass rate | **${pct(summary.passRate)}** (${summary.passed} of ${summary.questions}; needs ${pct(context.minPassRate ?? MIN_PASS_RATE)}) |`,
    `| Average correctness | ${summary.avgCorrectness ?? "–"} (${summary.graded} graded) |`,
    `| Safety passes | ${summary.safetyPasses} of ${summary.ran}${summary.safetyPasses === summary.ran ? "" : " ❌"} |`,
    `| Total cost | ${usd(summary.totalCostUsd)} (Copper ${usd(summary.appCostUsd)} + judge ${usd(summary.judgeCostUsd)}) |`,
    `| Average time per question | ${summary.avgSeconds ?? "–"} s |`,
    `| Langfuse run | ${context.url ? `[Open in Langfuse](${context.url})` : "–"} |`,
    "",
    failures.length
      ? `**Eval failed:** ${failures.join("; ")}.`
      : "**Eval passed.**",
    "",
    "<details><summary>Every question</summary>",
    "",
    "| Question | Passed | Correctness | Safe | Tools | Refund | Time | Cost |",
    "|---|---|---|---|---|---|---|---|",
    ...items.map((item) => {
      const seconds = value(item, "seconds");
      const cost = value(item, "cost_usd");
      return item.scores.length
        ? `| \`${item.id}\` | ${mark(value(item, "passed"))} | ${value(item, "correctness") ?? "–"} | ${mark(value(item, "safety"))} | ${mark(value(item, "used_right_tools"))} | ${mark(value(item, "refund_decision"))} | ${seconds === undefined ? "–" : `${seconds} s`} | ${cost === undefined ? "–" : usd(cost)} |`
        : `| \`${item.id}\` | ❌ failed to run | – | – | – | – | – | – |`;
    }),
    "",
    "</details>",
  ];
  const notes = items
    .filter((item) => value(item, "passed") !== 1)
    .map((item) => {
      const why =
        item.scores.find((s) => s.name === "passed")?.comment ??
        "failed to run";
      const judge = item.scores.find((s) => s.name === "correctness")?.comment;
      return `- \`${item.id}\`: ${why}${judge ? `. Judge: ${judge}` : ""}`;
    });
  if (notes.length)
    lines.push("", "**Answers that didn't pass**", "", ...notes);
  return `${lines.join("\n")}\n`;
}
