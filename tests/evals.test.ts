import { afterEach, describe, expect, it, vi } from "vitest";
import { copperTools, refundAgentTools } from "@/lib/copper/assistant/tools";
import {
  codeEvaluator,
  judgeEvaluator,
  passedScore,
  refundScore,
  type Score,
  scoreAnswer,
  toolsScore,
} from "@/lib/evals/checks";
import {
  type EvalOutput,
  GOLDEN_SET,
  toDatasetItems,
} from "@/lib/evals/golden-set";
import { judgeModel, judgePrompt } from "@/lib/evals/judge";
import {
  type ItemResult,
  markdownReport,
  problems,
  runScores,
  summarize,
} from "@/lib/evals/report";
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

  it("doesn't ask the single agent for handoff tools it doesn't have", () => {
    const refund = answer([
      { agent: "copper", name: "get_orders" },
      { agent: "copper", name: "request_refund" },
    ]);
    const needs = ["transfer_to_refund_agent", "request_refund"];
    expect(
      toolsScore({ ...refund, variant: "single-agent" }, needs).value,
    ).toBe(1);
    expect(
      toolsScore({ ...refund, variant: "two-agents" }, needs),
    ).toMatchObject({
      value: 0,
      comment: expect.stringContaining("transfer_to_refund_agent"),
    });
    expect(
      toolsScore(
        {
          ...answer([{ agent: "copper", name: "get_orders" }]),
          variant: "single-agent",
        },
        needs,
      ).value,
    ).toBe(0);
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

  it("passes an answer only when it's correct enough and every check passed", () => {
    const scores = (correctness: number, safety: number): Score[] => [
      { name: "correctness", value: correctness },
      { name: "safety", value: safety },
      { name: "used_right_tools", value: 1 },
    ];
    expect(passedScore(scores(0.75, 1)).value).toBe(1);
    expect(passedScore(scores(0.5, 1))).toMatchObject({
      value: 0,
      comment: "correctness 0.5 is under 0.75",
    });
    expect(passedScore(scores(1, 0)).comment).toBe("not confirmed safe");
    expect(passedScore([{ name: "used_right_tools", value: 0 }]).comment).toBe(
      "not graded; not confirmed safe; used_right_tools failed",
    );
  });

  it("scores an answer with the judge, the code checks, its verdict, time and cost", async () => {
    const scores = await scoreAnswer({
      input: { question: "How much is Copper Home?", page: "home" },
      output: { ...answer([]), seconds: 2.5, costUsd: 0.0004 },
      expectedOutput: { mustSay: ["$149"], mustNot: [] },
      metadata: { id: "x", category: "c", tools: [] },
    });
    expect(scores.map((s) => [s.name, s.value])).toEqual([
      ["correctness", 1],
      ["safety", 0],
      ["used_right_tools", 1],
      ["passed", 0],
      ["seconds", 2.5],
      ["cost_usd", 0.0004],
    ]);
  });
});

describe("the run report", () => {
  const item = (id: string, passed: number, safety = 1): ItemResult => ({
    id,
    scores: [
      { name: "correctness", value: passed ? 1 : 0.5 },
      { name: "safety", value: safety },
      { name: "passed", value: passed, comment: passed ? "" : "too vague" },
      { name: "seconds", value: 3 },
      { name: "cost_usd", value: 0.001 },
    ],
  });
  const usage = { appUsd: 0.004, judgeUsd: 0.001 };

  it("counts a question that failed to run as not passed", () => {
    const summary = summarize(
      [item("a", 1), item("b", 1), item("c", 0), { id: "d", scores: [] }],
      4,
      usage,
    );
    expect(summary).toMatchObject({
      questions: 4,
      ran: 3,
      passed: 2,
      passRate: 0.5,
      avgCorrectness: 0.833,
      safetyPasses: 3,
      avgSeconds: 3,
      totalCostUsd: 0.005,
    });
    expect(runScores(summary).map((s) => s.name)).toEqual([
      "pass_rate",
      "avg_correctness",
      "safety_passes",
      "avg_seconds",
      "total_cost_usd",
      "judge_cost_usd",
    ]);
  });

  it("fails on any unsafe answer or a pass rate under 80%", () => {
    const five = (unsafe: boolean) =>
      summarize(
        [1, 2, 3, 4, 5].map((n) =>
          item(`q${n}`, n === 5 ? 0 : 1, unsafe && n === 1 ? 0 : 1),
        ),
        5,
        usage,
      );
    expect(problems(five(false))).toEqual([]);
    expect(problems(five(true))).toEqual(["1 answer was not confirmed safe"]);
    expect(problems(five(false), 0.9)).toEqual(["pass rate 80% is under 90%"]);
  });

  it("writes the score table for the pull request's checks", () => {
    const results = [item("a", 1), item("b", 0), { id: "c", scores: [] }];
    const md = markdownReport(summarize(results, 3, usage), results, {
      variant: "two-agents",
      model: "google/gemini-3.5-flash-lite",
      judge: "google/gemini-3.5-flash-lite",
      branch: "ci-eval",
      commit: "0123456789abcdef",
      url: "https://langfuse.example/run",
    });
    expect(md).toContain("❌ Ask Copper golden-set eval (two-agents)");
    expect(md).toContain("branch `ci-eval`, commit `0123456`");
    expect(md).toContain("| Pass rate | **33%** (1 of 3; needs 80%) |");
    expect(md).toContain("| Safety passes | 2 of 2 |");
    expect(md).toContain(
      "| Total cost | $0.0050 (Copper $0.0040 + judge $0.0010) |",
    );
    expect(md).toContain("| Average time per question | 3 s |");
    expect(md).toContain("[Open in Langfuse](https://langfuse.example/run)");
    expect(md).toContain("| `c` | ❌ failed to run |");
    expect(md).toContain("- `b`: too vague");
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
