// Module 5: the golden set, the questions Ask Copper must get right before it
// ships (golden-set.json). npm run eval asks Copper each one, then an AI judge
// (judge.ts) and code checks (checks.ts) score the answers in Langfuse.
import { askCopper } from "@/lib/copper/assistant/ask";
import type { ToolStep } from "@/lib/copper/assistant/progress";
import { finalValue } from "@/lib/ai/live";
import { DEFAULT_LIMIT_USD } from "@/lib/copper/orders";
import data from "./golden-set.json";

export type GoldenItem = {
  id: string;
  category: string;
  /** "support": the Support page, where Copper can hand off to the Refund agent. */
  page: "home" | "support";
  question: string;
  /** Facts the answer must state. The judge checks these. */
  mustSay: string[];
  /** Things the answer must never do. The judge checks these. */
  mustNot: string[];
  /** Tools Copper must call; "a|b" means either. Checked in code. */
  tools: string[];
  /** The app's refund decision the answer must lead to. Checked in code. */
  refund?: { orderId: string; status: "refunded" | "needs_approval" };
};

export const GOLDEN_SET = {
  name: data.name,
  description: data.description,
  items: data.items as GoldenItem[],
};

/** What the eval sends Copper for one item (the Langfuse dataset item input). */
export type EvalInput = { question: string; page: GoldenItem["page"] };

/** What the judge grades against (the dataset item's expected output). */
export type EvalExpected = Pick<GoldenItem, "mustSay" | "mustNot">;

/** Checked in code, so kept apart from what the judge sees. */
export type EvalMetadata = Pick<GoldenItem, "id" | "category" | "tools"> & {
  refund?: GoldenItem["refund"];
};

/** Ask Copper's answer to one item, as the judge and checks see it. */
export type EvalOutput = {
  reply: string;
  /** Agents that answered, in order: ["copper"] or ["copper", "refund"]. */
  agents: string[];
  tools: { agent: string; name: string; output?: unknown }[];
  /** How long Copper took to answer, in seconds (set by npm run eval). */
  seconds?: number;
  /** What Copper's model calls cost for this answer (set by npm run eval). */
  costUsd?: number;
};

/** The golden set as Langfuse dataset items. Stable ids, so re-syncing updates them. */
export function toDatasetItems() {
  return GOLDEN_SET.items.map((item) => ({
    id: `${GOLDEN_SET.name}-${item.id}`,
    input: { question: item.question, page: item.page } satisfies EvalInput,
    expectedOutput: {
      mustSay: item.mustSay,
      mustNot: item.mustNot,
    } satisfies EvalExpected,
    metadata: {
      id: item.id,
      category: item.category,
      tools: item.tools,
      ...(item.refund && { refund: item.refund }),
    } satisfies EvalMetadata,
  }));
}

/**
 * Asks Copper one golden-set question, the way the chat panel does: with
 * tools, and on the Support page with a fresh Refund Console (the $50 limit,
 * no refunds yet). Throws if Copper fails, so an outage isn't scored as a
 * wrong answer.
 */
export async function askGolden(input: EvalInput): Promise<EvalOutput> {
  const { progress } = await askCopper({
    messages: [{ role: "user", content: input.question }],
    useTools: true,
    ...(input.page === "support" && {
      desk: { limitUsd: DEFAULT_LIMIT_USD, refunds: [] },
    }),
  });
  const result = await finalValue(progress);
  if (result.status !== "done")
    throw new Error(`Ask Copper failed on "${input.question}"`);
  const agents = [
    "copper",
    ...result.steps.flatMap((s) => (s.type === "handoff" ? [s.to] : [])),
  ];
  return {
    reply: result.reply,
    agents,
    tools: result.steps
      .filter((s): s is ToolStep => s.type === "tool")
      .map((s) => ({
        agent: s.agent ?? "copper",
        name: s.name,
        output: s.output,
      })),
  };
}
