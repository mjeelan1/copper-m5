// Module 5: which version of Ask Copper answers on the Support page.
// "two-agents" (the default): Copper hands refunds to the Refund agent.
// "single-agent": one support agent has all their tools and no handoff.
// Set ASK_COPPER_AGENTS=single-agent in .env.local to try the single agent.

export const AGENT_VARIANTS = ["two-agents", "single-agent"] as const;

export type AgentVariant = (typeof AGENT_VARIANTS)[number];

export function agentVariant(): AgentVariant {
  return process.env.ASK_COPPER_AGENTS === "single-agent"
    ? "single-agent"
    : "two-agents";
}
