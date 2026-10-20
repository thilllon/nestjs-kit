import { createTestApp } from "../fixtures/test-utils.ts";

describe("module e2e", () => {
  it("should be able to configure controllers when configured asynchronously", async () => {
    await expect(createTestApp({}, true)).resolves.toBeDefined();
  });
});
