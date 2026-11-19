import { afterEach, describe, expect, it, vi } from "vitest";
import { copperTools, refundAgentTools } from "@/lib/copper/assistant/tools";
import {
  averages,
  codeEvaluator,
  judgeEvaluator,
  refundScore,
  toolsScore,
} from "@/lib/evals/checks";
import {
  type EvalOutput,
  GOLDEN_SET,
  toDatasetItems,
} from "@/lib/evals/golden-set";
import { judgeModel, judgePrompt } from "@/lib/evals/judge";
import { withRetries } from "@/lib/evals/retry";

vi.mock("@/lib/evals/judge", async (original) => ({
  ...(await original<typeof import("@/lib/evals/judge")>()),
  judgeAnswer: vi.fn(async () => ({
    reasoning: "States the price.",
    correctness: 1,
    safe: false,
  })),
}));

const answer = (tools: EvalOutput["tools"]): EvalOutput => ({
  reply: "…",
  agents: ["copper"],
  tools,
});

describe("the golden set", () => {
  const items = GOLDEN_SET.items;
  const toolNames = new Set([
    ...Object.keys(copperTools),
    ...Object.keys(refundAgentTools({ limitUsd: 50, refunds: [] })),
    "transfer_to_refund_agent",
  ]);

  it("has unique ids and something for the judge to check", () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const item of items) {
      expect(item.question.trim()).not.toBe("");
      expect(item.mustSay.length).toBeGreaterThan(0);
    }
  });

  it("only names tools Copper and the Refund agent have", () => {
    for (const item of items)
      for (const need of item.tools)
        for (const name of need.split("|")) expect(toolNames).toContain(name);
  });

  it("asks refund questions on the Support page, where refunds happen", () => {
    for (const item of items.filter((i) => i.refund))
      expect(item.page).toBe("support");
  });

  it("becomes Langfuse dataset items with stable ids", () => {
    const [first] = toDatasetItems();
    expect(first.id).toBe(`${GOLDEN_SET.name}-${items[0].id}`);
    expect(first.input).toEqual({
      question: items[0].question,
      page: items[0].page,
    });
    expect(first.expectedOutput).toEqual({
      mustSay: items[0].mustSay,
      mustNot: items[0].mustNot,
    });
  });
});

describe("code checks", () => {
  it("passes when every needed tool was used, either of a|b", () => {
    const out = answer([{ agent: "copper", name: "get_products" }]);
    expect(toolsScore(out, ["get_prices|get_products"]).value).toBe(1);
    expect(toolsScore(out, ["search_docs"])).toMatchObject({
      value: 0,
      comment: expect.stringContaining("Missing: search_docs"),
    });
    expect(toolsScore(answer([]), []).value).toBe(1);
  });

  it("checks the app's refund decision, not the reply", () => {
    const out = answer([
      {
        agent: "refund",
        name: "request_refund",
        output: { status: "needs_approval", orderId: "1004" },
      },
    ]);
    expect(
      refundScore(out, { orderId: "1004", status: "needs_approval" }).value,
    ).toBe(1);
    expect(
      refundScore(out, { orderId: "1004", status: "refunded" }).value,
    ).toBe(0);
  });

  it("scores refunds only for items that expect one", async () => {
    const scores = await codeEvaluator({
      input: { question: "q", page: "home" },
      output: answer([]),
      metadata: { id: "x", category: "c", tools: [] },
    });
    expect(scores.map((s) => s.name)).toEqual(["used_right_tools"]);
  });

  it("averages each score over the run", () => {
    expect(
      averages([
        [{ name: "correctness", value: 1 }],
        [{ name: "correctness", value: 0.5 }],
      ]),
    ).toEqual([{ name: "avg_correctness", value: 0.75 }]);
  });
});

describe("the AI judge", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("turns the judge's verdict into correctness and safety scores", async () => {
    const scores = await judgeEvaluator({
      input: { question: "How much is Copper Home?", page: "home" },
      output: answer([]),
      expectedOutput: { mustSay: ["$149"], mustNot: [] },
    });
    expect(scores).toEqual([
      expect.objectContaining({
        name: "correctness",
        value: 1,
        comment: "States the price.",
      }),
      expect.objectContaining({
        name: "safety",
        value: 0,
        dataType: "BOOLEAN",
      }),
    ]);
  });

  it("shows the judge the question, answer and rubric", () => {
    const prompt = judgePrompt("Q?", "A.", {
      mustSay: ["fact"],
      mustNot: [],
    });
    expect(prompt).toContain("Q?");
    expect(prompt).toContain("A.");
    expect(prompt).toContain("MUST SAY:\n- fact");
    expect(prompt).toContain("MUST NOT:\n- (none)");
  });

  it("uses Flash-Lite unless EVAL_JUDGE_MODEL names an approved model", () => {
    expect(judgeModel()).toBe("google/gemini-3.5-flash-lite");
    vi.stubEnv("EVAL_JUDGE_MODEL", "google/gemini-3-flash");
    expect(judgeModel()).toBe("google/gemini-3-flash");
    vi.stubEnv("EVAL_JUDGE_MODEL", "gpt-5");
    expect(judgeModel()).toBe("google/gemini-3.5-flash-lite");
  });
});

describe("retries", () => {
  it("tries again after a failure, then gives up", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValue("ok");
    await expect(withRetries("x", flaky, { waitMs: 0 })).resolves.toBe("ok");
    expect(flaky).toHaveBeenCalledTimes(2);

    const broken = vi.fn().mockRejectedValue(new Error("429"));
    await expect(
      withRetries("x", broken, { tries: 2, waitMs: 0 }),
    ).rejects.toThrow("429");
    expect(broken).toHaveBeenCalledTimes(2);
  });
});
