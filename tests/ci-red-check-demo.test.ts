import { expect, test } from "vitest";

// Throwaway: proves branch protection blocks a PR with a failing test.
test("deliberately fails", () => {
  expect(1).toBe(2);
});
