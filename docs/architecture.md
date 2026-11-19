# Architecture

How the Copper State Labs app fits together. Each module adds a section at the
end (see [Adding a module](#adding-a-module)) when it changes how the app
works: new pages, tables or AI calls.

_Fictional — for educational use._

## The starter app (Module 0)

A Next.js app that builds, runs and deploys with **no environment variables**.
A Google AI Studio key is optional until a module needs one.

| Piece | Where | What it does |
|---|---|---|
| Pages | `app/` | `layout.tsx` sets the fonts and theme; `page.tsx` is the placeholder home page |
| Brand components | `components/copper/` | `Logo`, `SiteHeader`, `SiteFooter`, `ModeToggle` |
| UI kit | `components/ui/` (shadcn), `components/ai-elements/` (AI Elements) | The only UI libraries the app uses |
| Setup card | `components/setup-required.tsx` | `<SetupRequired service="ai" />`, shown instead of a page whose service isn't configured |
| Company catalog | `lib/copper/catalog.ts`, `lib/copper/data/catalog.json` | Product, plan and privacy facts from the Product Bible (Sections 3, 4, 8 and 10). Pages read prices and plan details from here instead of typing them (added in the Module 1 starter) |
| AI wrapper | `lib/ai/call.ts` | `callText` and `callObject`: every model call goes through these and is logged to the terminal |
| Models and prices | `lib/ai/models.ts`, `lib/ai/pricing.ts` | The approved Gemini models and their token prices |

## Data flow

1. A user opens a page in `app/`.
2. Server code checks what's configured (`isAiConfigured()`). If the key is
   missing, the page renders `<SetupRequired />` instead of crashing.
3. Data comes from files under `lib/copper/data/`.
4. AI requests go through `callText` / `callObject` in `lib/ai/call.ts`, which
   calls Google and then prints one `[ai_calls]` line: `module`, `feature`,
   `model`, tokens, `cost_usd`, `latency_ms`, `ok`.

```ts
const { text } = await callText(
  { module: 2, feature: "ask-copper" },
  { prompt },
);
```

## Two kinds of "AI tiers"

Don't mix these up:

- **Copper State Labs' product tiers** (On-device, Raw Ore, Refined, the
  Copper Cloud) are part of the fictional company. They are facts in the
  [Product Bible](copper-state-labs/product-bible.md) and rows in the `ai_tiers`
  table.
- **The models this app calls** are real Claude models listed in
  `lib/ai/models.ts`. Their cost is logged in `ai_calls`.

## Decisions

- **No environment variables required.** Every service is optional, so a fresh
  clone builds and deploys before any accounts are set up.
- **One AI wrapper.** Routing every call through `lib/ai/call.ts` gives one
  place to log cost and latency per module and feature.
- **No authentication or row-level security yet.** They arrive in a later
  module.

## Adding a module

When a module changes how the app fits together, add a section here:

```md
## Module N: <feature name>

**Summary:** one or two sentences: what this adds and why.

| Piece | Where | What it does |
|---|---|---|
| Page / route | `app/...` | |
| Components | `components/...` | |
| Data | `lib/copper/data/...` | Data files added |
| AI calls | `lib/ai/call.ts` (module, feature) | Model, prompt purpose, expected cost per call |

**Data flow:** user action → page → server code → database / model → response.

**Decisions and trade-offs:** what you chose, the alternatives, and why.

**Risks and open questions:** cost, privacy, accuracy or safety risks, and how
you handle them.
```

## Module 3 starter: Ask Copper

**Summary:** Ask Copper, the Module 2 shopping chatbot, finished: a floating
chat panel that answers prices, totals and stock with four tools and shows
each step. Module 3 teaches it to answer from the customer documents.

| Piece | Where | What it does |
|---|---|---|
| Component | `components/copper/ask-copper.tsx` | The launcher and chat panel, mounted from `app/page.tsx` and opened by the header's `#ask` link. Draws each answer as stations: the tools on offer, thinking, each tool call, then the reply |
| Server Action | `lib/copper/assistant/ask.ts` | `askCopper()`: streams the conversation with `callStream`, up to 5 steps, and sends each step back as a live `Progress` |
| Tools | `lib/copper/assistant/tools.ts` | `copperTools`: `get_products`, `get_prices`, `calculate_cost`, `check_availability` |
| Instructions | `lib/copper/assistant/instructions.ts` | `COPPER_INSTRUCTIONS`. Copper says it can't help yet with warranty, setup, troubleshooting or privacy |
| Data | `lib/copper/inventory.ts`, `lib/copper/documents.ts` | Stock from `lib/copper/data/inventory.json`; `DOCUMENTS`: the four customer documents and their PDF paths under `public/docs/`. The PDFs are added in class |
| AI calls | `{ module: 2, feature: "ask-copper" }` | One streamed call per question |

## Module 3: Document passages and embeddings

**Summary:** The four customer PDFs in `public/docs/` are split into passages
of a few sentences and embedded with Gemini, so Ask Copper can find the
passages that answer a question and cite their page.

| Piece | Where | What it does |
|---|---|---|
| Build script | `scripts/embed-docs.mjs` (`npm run embed-docs`) | Reads each PDF in `DOCUMENTS` page by page (with `unpdf`), splits pages with `splitPage()`, embeds every passage and writes the JSON. Re-run it when a PDF changes |
| Splitter | `lib/copper/split-passages.ts` | `splitPage()`: drops the footer lines, then groups sentences three at a time (at most ~600 characters) |
| Data | `lib/copper/data/passages.json`, `lib/copper/passages.ts` | `PASSAGES`: `documentId`, `title`, `page`, `text` (starts with the document title) and `embedding`. Importing it loads every passage into memory once per server |
| Tool | `lib/copper/assistant/tools.ts` | `search_docs`: embeds the question, ranks every passage by cosine similarity and returns the 5 closest with title, page, a `/docs/<file>.pdf#page=N` link and a score. The tool card lists them with links; the instructions tell Copper to use it for setup, troubleshooting, warranty and policy questions and to cite the page |
| Citations | `lib/copper/assistant/citations.ts`, `lib/copper/assistant/instructions.ts` | Copper answers document questions only from `search_docs`, ends every sentence with `[Title, p. N]`, and says "I couldn't find that in our support docs" otherwise. `splitCitations()` lets the panel link each citation to that PDF page; unknown titles stay plain text |
| AI calls | `callEmbedMany` in `lib/ai/call.ts`, `{ module: 3, feature: "embed-docs" }` | `gemini-embedding-2` at 768 dimensions. One call per run of the script, plus one `{ module: 3, feature: "search-docs" }` call per search. Google doesn't report embedding tokens, so the log's tokens and cost are null |

**Data flow:** PDF → pages → passages → Gemini embeddings → `passages.json` →
`PASSAGES` in memory. Question → `search_docs` → question embedding → 5
closest passages → Copper answers from them and cites the page.

**Decisions and trade-offs:** A JSON file in memory instead of a vector
database: about 120 passages is under 1 MB, so searching all of them is
instant and needs no new service. 768 dimensions instead of 3072 keeps the
file small with little loss in accuracy. The title goes at the start of each
passage so similar passages from different documents (Copper Home vs. Copper
Notes) embed differently.

**Risks and open questions:** Questions must be embedded with the same model
and dimensions (`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`) or the search
returns nonsense. Tables lose their columns when turned into text. Embeddings match meaning
better than exact strings, so an error code like C-47 can rank below other
error-code passages (it was third in testing); keyword search alongside would fix that.

## Module 4: Refund agent, handoff and approvals

**Summary:** On the Support page, Copper hands refund requests to a second
agent, the Refund agent, with its own instructions and tools. The app (code,
not the model) compares the order amount with an auto-refund limit you can
change: at or under it, the refund goes through; over it, the refund waits on
the Refund Console until a person clicks Approve or Reject, and the Refund
agent tells the customer.

| Piece | Where | What it does |
|---|---|---|
| Orders and the rule | `lib/copper/orders.ts`, `lib/copper/data/orders.json` | Maya Reyes's four orders (#1001 to #1004). `requestRefund()` decides: `refunded` at or under the limit, `needs_approval` over it; an order already decided keeps its status; `not_found` for unknown numbers |
| Handoffs | `lib/copper/assistant/tools.ts`, `ask.ts` | Copper's `transfer_to_refund_agent` (Support page only) and the Refund agent's `transfer_to_copper`. Each ends that agent's turn (`hasToolCall`); the other agent answers the same conversation. The agent that ends a turn answers the next message |
| Refund agent | `lib/copper/assistant/instructions.ts` (`REFUND_AGENT_INSTRUCTIONS`), `tools.ts` (`refundAgentTools`) | `get_orders` and `request_refund`, built on the desk the chat sends. Copper can't use these |
| Refund Console | `app/support/page.tsx`, `components/copper/refund-console.tsx` | The auto-refund limit ($50 to start), the refunds waiting for approval with Approve and Reject, and the orders with their status. State lives in the page: a reload starts fresh |
| Chat panel | `components/copper/ask-copper.tsx` | With `support`, sends the desk (limit and refunds so far) and the current agent with each message, puts each `request_refund` decision on the console, and sends the console's "[Refund Console] A supervisor approved …" note to the Refund agent, which tells the customer. Shows each handoff as its own station |
| AI calls | `{ module: 2, feature: "ask-copper" }`, `{ module: 4, feature: "refund-agent" }` | One call per agent in a turn |

**Data flow:** question → Copper → `transfer_to_refund_agent` → Refund agent
→ `request_refund` → the app compares the amount with the limit → refunded,
or waiting on the Refund Console → Approve or Reject → console note → Refund
agent tells the customer.

**Decisions and trade-offs:** The refund decision is code, so the model can't
argue past the limit. Two agents keep refund tools away from Copper. A real
handoff (the other agent answers) rather than an agent called as a tool keeps
one voice per reply. The console's state lives in the browser and goes with
each message, so there's nothing to set up and nothing stored on the server;
the cost is that a reload forgets every refund.

**Risks and open questions:** A customer can claim a supervisor already
approved; the Refund agent must still ask the app. Setting the limit to 0
sends every refund to a person. A real app needs a database so refunds
survive a reload and several supervisors see the same queue.

## Module 5 starter

**Summary:** Module 4 as finished. Module 5 makes Ask Copper safe to ship:
the tests and a golden-set evaluation with an AI judge run in GitHub Actions
on every pull request, with `main` protected; every AI call is traced in
Langfuse; and one support agent that does everything is compared with the two
agents on the same golden set. Langfuse is the only eval and monitoring tool.

## Module 5: Langfuse tracing

**Summary:** Every AI call is traced in Langfuse, so you can see what each
agent did, which tools it called, and the tokens, cost and time of every step.
Each Ask Copper turn is one trace.

| Piece | Where | What it does |
|---|---|---|
| Startup | `instrumentation.ts`, `lib/ai/tracing.ts` | When the server starts, `startTracing()` registers Langfuse with the AI SDK (`@langfuse/vercel-ai-sdk`) and an OpenTelemetry tracer that sends spans to Langfuse (`@langfuse/otel`). Without the keys it does nothing |
| Call names | `lib/ai/call.ts` | Every call passes `telemetry.functionId` = its feature (`ask-copper`, `refund-agent`, `search-docs`), so it shows by name in Langfuse |
| Turn trace | `lib/copper/assistant/ask.ts` | One trace per turn, named `ask-copper` and tagged (`support-page` or `home-page`, `tools` or `no-tools`, `two-agents`). Input is the customer's message, output is the reply. A span per agent (`Copper`, `Refund agent`) holds that agent's model calls and tool calls. `after()` sends the trace once the turn ends |
| Keys | `.env.local`, Vercel | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (the region: EU `https://cloud.langfuse.com`, US `https://us.cloud.langfuse.com`) |

**Data flow:** customer message → `askCopper` → trace `ask-copper` → span
`Copper` → model calls and tools (→ span `Refund agent` after a handoff) →
reply → trace sent to Langfuse.

**Decisions and trade-offs:** Langfuse's own AI SDK v7 integration rather than
the generic OpenTelemetry one, so model calls arrive as Langfuse generations
with tokens. `@ai-sdk/otel` is pinned to the app's `ai` version so there is
one copy of the AI SDK. The app's own `[ai_calls]` log stays: it works without
Langfuse.

**Risks and open questions:** Traces include what customers type and the
replies, so they hold personal data; Langfuse's `mask` option can redact it.
Langfuse prices only models it knows; if a trace shows no cost, add the model
in Langfuse with the prices in `lib/ai/pricing.ts`.

## Module 5: Golden set and AI judge

**Summary:** `npm run eval` asks Ask Copper every question in a golden set,
grades each answer with an AI judge (LLM-as-a-judge) and code checks, and saves
the answers and scores in Langfuse as one experiment run, so runs can be
compared side by side. It fails when the answers aren't good enough.

| Piece | Where | What it does |
|---|---|---|
| Golden set | `lib/evals/golden-set.json`, `golden-set.ts` | 15 questions (products, stock, cost, troubleshooting, policy, privacy, refunds, safety). Each has `mustSay` and `mustNot` for the judge, and the `tools` and `refund` decision for the code checks. Synced to the Langfuse dataset `ask-copper-golden-set` with stable ids |
| Task | `lib/evals/golden-set.ts` (`askGolden`) | Asks Copper like the chat panel does, with tools; Support-page items get a fresh Refund Console ($50 limit) |
| AI judge | `lib/evals/judge.ts` (module 5, feature `ai-judge`) | Reads the question, the answer and the rubric; returns `correctness` (0 to 1), `safe` and its reasoning. Temperature 0. Gemini 3.5 Flash-Lite by default (`EVAL_JUDGE_MODEL` can pick Gemini 3 Flash) |
| Code checks | `lib/evals/checks.ts` | `used_right_tools` and `refund_decision`: facts with one right answer, so no model |
| Runner | `scripts/eval.mjs`, `scripts/load-app.mjs` | Langfuse `experiment.run` on the dataset, one question at a time with a wait-and-retry for rate limits (`lib/evals/retry.ts`). Prints a table and the judge's reasoning. Exit 1 if average correctness is under `EVAL_MIN_CORRECTNESS` (0.8), any answer is unsafe or ungraded, or a question fails to run |

**Scores in Langfuse:** each answer's trace gets `correctness`, `safety`,
`used_right_tools` and (refund items) `refund_decision`, with the judge's
reasoning as the comment; the run gets `avg_*` of each. Open the dataset's
Experiments tab to compare runs.

**Data flow:** `npm run eval` → golden set → Langfuse dataset → for each item:
`askCopper` → answer → judge (`callObject`) + code checks → scores on the trace
→ run averages → pass or fail.

**Decisions and trade-offs:** The judge runs in our code through
`lib/ai/call.ts`, not as a Langfuse-hosted evaluator, so it uses the same Gemini
key and logging as every other call, and the scores still land in Langfuse. A
judge should be stronger than the model it grades, but Google's free tier
allows Gemini 3 Flash only 20 requests a day; Flash-Lite allows 15 a minute, so
the judge uses Flash-Lite with a strict rubric, and it scored known-bad answers
(a wrong fix, the old 18-month privacy policy, a leaked known issue, a promised
refund) as 0 and unsafe. What can be checked in code (tools, the refund
decision) is.

**Risks and open questions:** A judge can be wrong or lenient: read its
reasoning when a score moves, and add a golden item for every bug found. The
free-tier rate limit makes a full run take several minutes. The rubric must
match the customer documents, not the Product Bible's intentional conflicts.
