// Module 5: traces every AI call in Langfuse (observability).
// startTracing() runs once when the server starts (instrumentation.ts). It
// registers Langfuse with the AI SDK, so every call made through
// lib/ai/call.ts (each agent, its tool calls, tokens and time) shows up in
// Langfuse. Without the Langfuse keys it does nothing and the app runs as
// before.

/** Set once tracing has started; shared across the server's module copies. */
const state = globalThis as typeof globalThis & {
  __copperTracing?: { flush: () => Promise<void> };
};

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/** True once startTracing() has connected the app to Langfuse. */
export function isTracingOn(): boolean {
  return Boolean(state.__copperTracing);
}

/**
 * Connects the AI SDK to Langfuse. Reads LANGFUSE_PUBLIC_KEY,
 * LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL. Safe to call more than once.
 * Returns whether tracing is on.
 */
export async function startTracing(): Promise<boolean> {
  if (state.__copperTracing) return true;
  if (!isTracingConfigured()) return false;
  // Imported here, so nothing loads unless the keys are set.
  const [
    { registerTelemetry },
    { LangfuseSpanProcessor },
    { LangfuseVercelAiSdkIntegration },
    { NodeTracerProvider },
  ] = await Promise.all([
    import("ai"),
    import("@langfuse/otel"),
    import("@langfuse/vercel-ai-sdk"),
    import("@opentelemetry/sdk-trace-node"),
  ]);
  const processor = new LangfuseSpanProcessor({
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
  state.__copperTracing = { flush: () => processor.forceFlush() };
  return true;
}

/** Sends any traces still waiting. Call before a script or request ends. */
export async function flushTracing(): Promise<void> {
  await state.__copperTracing?.flush();
}
