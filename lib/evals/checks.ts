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

/** Code: did Copper call every tool the item needs? ("a|b" means either.) */
export function toolsScore(output: EvalOutput, tools: string[]): Score {
  const used = new Set(output.tools.map((t) => t.name));
  const missing = tools.filter(
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

/** The run's averages, saved on the whole experiment run in Langfuse. */
export function averages(
  itemScores: Score[][],
): { name: string; value: number }[] {
  const all = itemScores.flat();
  const names = [...new Set(all.map((s) => s.name))];
  return names.map((name) => {
    const values = all.filter((s) => s.name === name).map((s) => s.value);
    return {
      name: `avg_${name}`,
      value:
        Math.round(
          (values.reduce((sum, v) => sum + v, 0) / values.length) * 1000,
        ) / 1000,
    };
  });
}
