import { describe, expect, it } from "vitest";
import {
  AopConfigurationError,
  AopNotReadyError,
  AopUsageError,
} from "./errors";

describe("aspect errors", () => {
  it.each([
    ["AopConfigurationError", AopConfigurationError],
    ["AopUsageError", AopUsageError],
    ["AopNotReadyError", AopNotReadyError],
  ])("%s reports its class name", (name, ErrorClass) => {
    expect(String(new ErrorClass("invalid pointcut"))).toBe(
      `${name}: invalid pointcut`,
    );
  });
});
