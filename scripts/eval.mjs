// npm run eval: asks Ask Copper every question in the golden set
// (lib/evals/golden-set.json), grades each answer with the AI judge and the
// code checks (lib/evals/checks.ts), and saves it all in Langfuse as one
// experiment run on the "ask-copper-golden-set" dataset, so runs can be
// compared side by side. Fails (exit 1) when the answers aren't good enough.
//
//   npm run eval                       every question
//   npm run eval -- --only error-c47   one question (by its id)
//
// Needs GOOGLE_GENERATIVE_AI_API_KEY and the three LANGFUSE_* keys. Optional:
// EVAL_MIN_CORRECTNESS (default 0.8) and EVAL_JUDGE_MODEL (lib/evals/judge.ts).
import "./load-app.mjs";

/** The run fails below this average correctness, or on any unsafe answer. */
const MIN_CORRECTNESS = Number(process.env.EVAL_MIN_CORRECTNESS ?? 0.8);
const VARIANT = "two-agents";

const { isAiConfigured } = await import("../lib/ai/call.ts");
const { defaultModel } = await import("../lib/ai/models.ts");
const { flushTracing, isTracingConfigured, startTracing } =
  await import("../lib/ai/tracing.ts");
const { GOLDEN_SET, askGolden, toDatasetItems } =
  await import("../lib/evals/golden-set.ts");
const { averages, codeEvaluator, judgeEvaluator } =
  await import("../lib/evals/checks.ts");
const { judgeModel } = await import("../lib/evals/judge.ts");
const { withRetries } = await import("../lib/evals/retry.ts");
const JUDGE_MODEL = judgeModel();

if (!isAiConfigured() || !isTracingConfigured()) {
  console.error(
    "eval: add GOOGLE_GENERATIVE_AI_API_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL to .env.local first.",
  );
  process.exit(1);
}
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
  `Asking Copper ${items.length} question(s) (${defaultModel()}), judged by ${JUDGE_MODEL}…`,
);

const result = await langfuse.experiment.run({
  name: "Ask Copper golden set",
  runName: `${VARIANT} ${new Date().toISOString().slice(0, 19)}Z`,
  description: `Ask Copper (${VARIANT}) on the golden set, judged by ${JUDGE_MODEL}.`,
  metadata: { variant: VARIANT, model: defaultModel(), judge: JUDGE_MODEL },
  data: items,
  task: async ({ input }) =>
    withRetries(`asking "${input.question}"`, () => askGolden(input)),
  evaluators: [judgeEvaluator, codeEvaluator],
  runEvaluators: [
    async ({ itemResults }) => averages(itemResults.map((r) => r.evaluations)),
  ],
  // One at a time, to stay under the free Gemini rate limits.
  maxConcurrency: 1,
});

// 3. Print a summary and decide pass or fail.
const score = (r, name) => r.evaluations.find((e) => e.name === name)?.value;
const mark = (v) => (v === undefined ? "–" : v === 1 ? "✓" : v === 0 ? "✗" : v);
const rows = result.itemResults.map((r) => ({
  id: r.item.metadata?.id,
  correctness: score(r, "correctness"),
  safety: mark(score(r, "safety")),
  tools: mark(score(r, "used_right_tools")),
  refund: mark(score(r, "refund_decision")),
}));
console.table(rows);
// The judge's reasoning for every answer that lost points.
for (const r of result.itemResults) {
  if (score(r, "correctness") === 1 && score(r, "safety") === 1) continue;
  const why = r.evaluations.find((e) => e.name === "correctness")?.comment;
  console.log(`- ${r.item.metadata?.id}: ${why ?? "not graded"}`);
}

const avg = Object.fromEntries(
  result.runEvaluations.map((e) => [e.name, e.value]),
);
const unsafe = rows.filter((r) => r.safety !== "✓").map((r) => r.id);
const ran = new Set(rows.map((r) => r.id));
const failed = items.map((i) => i.metadata?.id).filter((id) => !ran.has(id));
console.log("\nAverages:", avg);
if (result.experimentUrl) console.log(`Langfuse: ${result.experimentUrl}`);

await langfuse.flush();
await flushTracing();

const problems = [
  (avg.avg_correctness ?? 0) < MIN_CORRECTNESS &&
    `average correctness ${avg.avg_correctness} is under ${MIN_CORRECTNESS}`,
  unsafe.length && `unsafe or ungraded answers: ${unsafe.join(", ")}`,
  failed.length && `questions that failed to run: ${failed.join(", ")}`,
].filter(Boolean);
if (problems.length) {
  console.error(`\nEval FAILED: ${problems.join("; ")}.`);
  process.exit(1);
}
console.log("\nEval passed.");
process.exit(0);
