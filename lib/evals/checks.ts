// Module 5: the Langfuse evaluators for the golden set. The AI judge grades
// what the answer says; code checks what Copper did (its tools and the app's
// refund decision), since those have one right answer and need no model.
import type {
  EvalExpected,
  EvalInput,
  EvalMetadata,
  EvalOutput,
} from "@/lib/evals/golden-set";
import { judgeAnswer } from "@/lib/evals/judge";
import { withRetries } from "@/lib/evals/retry";

/** A score as Langfuse stores it (the client's Evaluation shape). */
export type Score = {
  name: string;
  value: number;
  comment?: string;
  dataType?: "NUMERIC" | "BOOLEAN";
};

type EvaluatorParams = {
  input: EvalInput;
  output: EvalOutput;
  expectedOutput?: EvalExpected;
  metadata?: EvalMetadata;
};

/** AI judge: "correctness" (0 to 1) and "safety" (pass or fail). */
export async function judgeEvaluator({
  input,
  output,
  expectedOutput,
}: EvaluatorParams): Promise<Score[]> {
  if (!expectedOutput) return [];
  const verdict = await withRetries(`judging "${input.question}"`, () =>
    judgeAnswer(input.question, output.reply, expectedOutput),
  );
  return [
    {
      name: "correctness",
      value: verdict.correctness,
      comment: verdict.reasoning,
      dataType: "NUMERIC",
    },
    {
      name: "safety",
      value: verdict.safe ? 1 : 0,
      comment: verdict.reasoning,
      dataType: "BOOLEAN",
    },
  ];
}

/** The two agents' handoff tools; the single support agent has none. */
export const HANDOFF_TOOLS = ["transfer_to_refund_agent", "transfer_to_copper"];

/**
 * The tools an answer needs from this version: the single agent has no
 * handoff, so it's checked only for the tools that do the work (like
 * request_refund).
 */
export function neededTools(
  tools: string[],
  variant: EvalOutput["variant"],
): string[] {
  return variant === "single-agent"
    ? tools.filter((need) => !HANDOFF_TOOLS.includes(need))
    : tools;
}

/** Code: did Copper call every tool the item needs? ("a|b" means either.) */
export function toolsScore(output: EvalOutput, tools: string[]): Score {
  const used = new Set(output.tools.map((t) => t.name));
  const missing = neededTools(tools, output.variant).filter(
    (need) => !need.split("|").some((name) => used.has(name)),
  );
  return {
    name: "used_right_tools",
    value: missing.length ? 0 : 1,
    comment: missing.length
      ? `Missing: ${missing.join(", ")}. Used: ${[...used].join(", ") || "none"}.`
      : `Used: ${[...used].join(", ") || "no tools, as expected"}.`,
    dataType: "BOOLEAN",
  };
}

/** Code: did request_refund come back with the decision the item expects? */
export function refundScore(
  output: EvalOutput,
  refund: NonNullable<EvalMetadata["refund"]>,
): Score {
  const results = output.tools
    .filter((t) => t.name === "request_refund")
    .map((t) => t.output as { status?: string; orderId?: string } | undefined);
  const match = results.find(
    (r) => r?.orderId === refund.orderId && r?.status === refund.status,
  );
  return {
    name: "refund_decision",
    value: match ? 1 : 0,
    comment: match
      ? `Order ${refund.orderId}: ${refund.status}, as expected.`
      : `Expected order ${refund.orderId} to be ${refund.status}; got ${JSON.stringify(results) || "no refund request"}.`,
    dataType: "BOOLEAN",
  };
}

export async function codeEvaluator({
  output,
  metadata,
}: EvaluatorParams): Promise<Score[]> {
  if (!metadata) return [];
  return [
    toolsScore(output, metadata.tools),
    ...(metadata.refund ? [refundScore(output, metadata.refund)] : []),
  ];
}

/**
 * An answer passes when the judge gives it at least this much correctness
 * (three of four facts) and every pass-or-fail check passed.
 */
export const PASS_CORRECTNESS = 0.75;

/** Code: the answer's verdict, from the other scores. */
export function passedScore(scores: Score[]): Score {
  const value = (name: string) => scores.find((s) => s.name === name)?.value;
  const correctness = value("correctness");
  const reasons = [
    correctness === undefined
      ? "not graded"
      : correctness < PASS_CORRECTNESS &&
        `correctness ${correctness} is under ${PASS_CORRECTNESS}`,
    value("safety") !== 1 && "not confirmed safe",
    ...["used_right_tools", "refund_decision"].map(
      (name) => value(name) === 0 && `${name} failed`,
    ),
  ].filter((reason): reason is string => Boolean(reason));
  return {
    name: "passed",
    value: reasons.length ? 0 : 1,
    comment: reasons.length ? reasons.join("; ") : "Passed every check.",
    dataType: "BOOLEAN",
  };
}

/**
 * The one evaluator npm run eval uses: the AI judge, the code checks, the
 * verdict, and the answer's time and cost. If the judge can't be reached
 * (after retries), the answer is scored "not graded" instead of dropped.
 */
export async function scoreAnswer(params: EvaluatorParams): Promise<Score[]> {
  let judged: Score[] = [];
  try {
    judged = await judgeEvaluator(params);
  } catch (error) {
    console.warn(
      `[eval] judge failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  const scores = [...judged, ...(await codeEvaluator(params))];
  const { seconds, costUsd } = params.output;
  return [
    ...scores,
    passedScore(scores),
    ...(seconds === undefined
      ? []
      : [{ name: "seconds", value: seconds, dataType: "NUMERIC" as const }]),
    ...(costUsd === undefined
      ? []
      : [{ name: "cost_usd", value: costUsd, dataType: "NUMERIC" as const }]),
  ];
}
