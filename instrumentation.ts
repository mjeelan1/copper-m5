// Runs once when the server starts. Module 5: connects every AI call to
// Langfuse when the Langfuse keys are set (lib/ai/tracing.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTracing } = await import("./lib/ai/tracing");
  await startTracing();
}
