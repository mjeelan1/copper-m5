// npm run eval: asks Ask Copper every question in the golden set
// (lib/evals/golden-set.json), grades each answer with the AI judge and the
// code checks (lib/evals/checks.ts), and saves it all in Langfuse as one
// experiment run on the "ask-copper-golden-set" dataset, tagged with the
// commit and branch, so runs can be compared side by side. Prints a score
// table (and, in GitHub Actions, writes it to the job summary, which shows in
// the pull request's checks). Fails (exit 1) if any answer isn't confirmed
// safe or fewer than 80% of questions pass (lib/evals/report.ts).
//
//   npm run eval                       every question
//   npm run eval -- --only error-c47   one question (by its id)
//
// Needs GOOGLE_GENERATIVE_AI_API_KEY and the three LANGFUSE_* keys. Optional:
// EVAL_MIN_PASS_RATE (default 0.8), EVAL_JUDGE_MODEL (lib/evals/judge.ts),
// EVAL_BRANCH and EVAL_COMMIT (CI sets them; locally read from git).
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import "./load-app.mjs";

const VARIANT = "two-agents";

const { isAiConfigured, onAiCall } = await import("../lib/ai/call.ts");
const { defaultModel } = await import("../lib/ai/models.ts");
const { flushTracing, isTracingConfigured, startTracing } =
  await import("../lib/ai/tracing.ts");
const { GOLDEN_SET, askGolden, toDatasetItems } =
  await import("../lib/evals/golden-set.ts");
const { scoreAnswer } = await import("../lib/evals/checks.ts");
const { judgeModel } = await import("../lib/evals/judge.ts");
const { MIN_PASS_RATE, markdownReport, problems, runScores, summarize } =
  await import("../lib/evals/report.ts");
const { withRetries } = await import("../lib/evals/retry.ts");

const MIN = Number(process.env.EVAL_MIN_PASS_RATE ?? MIN_PASS_RATE);
const MODEL = defaultModel();
const JUDGE = judgeModel();

if (!isAiConfigured() || !isTracingConfigured()) {
  console.error(
    "eval: add GOOGLE_GENERATIVE_AI_API_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL to .env.local (or the repo's Actions secrets) first.",
  );
  process.exit(1);
}

/** The commit and branch this run tests, for Langfuse and the summary. */
const git = (args) => {
  try {
    return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
};
const commit = process.env.EVAL_COMMIT || git("rev-parse HEAD");
const branch = process.env.EVAL_BRANCH || git("branch --show-current");
// Every trace of this run carries the commit as its Langfuse "release".
if (commit && !process.env.LANGFUSE_RELEASE)
  process.env.LANGFUSE_RELEASE = commit;

await startTracing();
const { LangfuseClient } = await import("@langfuse/client");
const langfuse = new LangfuseClient();

// 1. Copy the golden set into the Langfuse dataset (same ids, so it updates).
const name = GOLDEN_SET.name;
try {
  await langfuse.api.datasets.get(name);
} catch {
  await langfuse.api.datasets.create({
    name,
    description: GOLDEN_SET.description,
  });
}
for (const item of toDatasetItems())
  await langfuse.api.datasetItems.create({ datasetName: name, ...item });

// 2. Ask Copper each question and score the answers.
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : undefined;
const dataset = await langfuse.dataset.get(name);
const ids = new Set(GOLDEN_SET.items.map((i) => i.id));
const items = dataset.items.filter(
  (i) => ids.has(i.metadata?.id) && (!only || i.metadata?.id === only),
);
if (!items.length) {
  console.error(`eval: no golden-set item with id "${only}".`);
  process.exit(1);
}
console.log(
  `Asking Copper ${items.length} question(s) (${MODEL}), judged by ${JUDGE}${branch ? `, on ${branch}` : ""}…`,
);

// Adds up what every model call costs: Copper's (per answer, too) and the judge's.
const usage = { appUsd: 0, judgeUsd: 0 };
let answer = null;
onAiCall((row) => {
  const cost = row.cost_usd ?? 0;
  if (row.feature === "ai-judge") usage.judgeUsd += cost;
  else {
    usage.appUsd += cost;
    if (answer) answer.costUsd += cost;
  }
});

/** One answer, timed and costed; retried after a minute if it fails. */
const ask = (input) =>
  withRetries(`asking "${input.question}"`, async () => {
    answer = { costUsd: 0 };
    const started = performance.now();
    const output = await askGolden(input);
    return {
      ...output,
      seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
      costUsd: Number(answer.costUsd.toFixed(6)),
    };
  });

const itemsOf = (itemResults) =>
  items.map((item) => ({
    id: item.metadata?.id,
    scores:
      itemResults.find((r) => r.item.metadata?.id === item.metadata?.id)
        ?.evaluations ?? [],
  }));

const result = await langfuse.experiment.run({
  name: "Ask Copper golden set",
  runName: [VARIANT, branch, commit?.slice(0, 7), new Date().toISOString()]
    .filter(Boolean)
    .join(" · "),
  description: `Ask Copper (${VARIANT}) on the golden set, judged by ${JUDGE}.`,
  metadata: {
    variant: VARIANT,
    model: MODEL,
    judge: JUDGE,
    branch,
    commit,
    ...(process.env.GITHUB_RUN_ID && {
      ciRun: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    }),
  },
  data: items,
  task: async ({ input }) => ask(input),
  evaluators: [scoreAnswer],
  runEvaluators: [
    async ({ itemResults }) =>
      runScores(summarize(itemsOf(itemResults), items.length, usage)),
  ],
  // One at a time: the free tier allows 15 requests a minute.
  maxConcurrency: 1,
});

// 3. Report and decide pass or fail.
const results = itemsOf(result.itemResults);
const summary = summarize(results, items.length, usage);
const report = markdownReport(summary, results, {
  variant: VARIANT,
  model: MODEL,
  judge: JUDGE,
  branch,
  commit,
  url: result.experimentUrl,
  minPassRate: MIN,
});
console.log(`\n${report}`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);

await langfuse.flush();
await flushTracing();

const failures = problems(summary, MIN);
if (failures.length) {
  console.error(`Eval FAILED: ${failures.join("; ")}.`);
  process.exit(1);
}
console.log("Eval passed.");
process.exit(0);
