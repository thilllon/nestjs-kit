import { describe, expect, it } from "vitest";
import { AspectUsageError } from "./errors";

describe("error classes", () => {
  it("test instanceof against a subclass by the prototype chain", () => {
    class QuotaError extends AspectUsageError {}

    expect(new AspectUsageError("used up") instanceof QuotaError).toBe(false);
    expect(new QuotaError("used up") instanceof AspectUsageError).toBe(true);
  });
});
