import { afterEach, describe, expect, it, vi } from "vitest";

// Langfuse tracing must stay off, and harmless, until its keys are set:
// the app and CI run without them.
describe("Langfuse tracing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is off without the Langfuse keys", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const tracing = await import("@/lib/ai/tracing");
    expect(tracing.isTracingConfigured()).toBe(false);
    expect(await tracing.startTracing()).toBe(false);
    expect(tracing.isTracingOn()).toBe(false);
    await expect(tracing.flushTracing()).resolves.toBeUndefined();
  });

  it("needs both keys", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const tracing = await import("@/lib/ai/tracing");
    expect(tracing.isTracingConfigured()).toBe(false);
  });

  it("only starts on the Node.js server", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const startTracing = vi.fn();
    vi.doMock("@/lib/ai/tracing", () => ({ startTracing }));
    const { register } = await import("@/instrumentation");
    await register();
    expect(startTracing).not.toHaveBeenCalled();
  });
});
