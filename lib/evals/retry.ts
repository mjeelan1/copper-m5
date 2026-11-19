// Google's free tier allows Gemini 3.5 Flash-Lite 15 requests a minute, and
// one golden-set question can take five (Copper, the Refund agent, the judge).
// So when a step fails, the eval waits for the minute to pass and tries again,
// instead of scoring a rate limit as a wrong answer.

/** Runs `run`, waiting `waitMs` and retrying up to `tries` times in all. */
export async function withRetries<T>(
  label: string,
  run: () => Promise<T>,
  { tries = 3, waitMs = 60_000 }: { tries?: number; waitMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= tries) throw error;
      console.warn(
        `[eval] ${label} failed (attempt ${attempt} of ${tries}); retrying in ${Math.round(waitMs / 1000)} s.`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
