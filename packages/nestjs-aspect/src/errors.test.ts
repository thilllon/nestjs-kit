import { describe, expect, it } from "vitest";
import {
  AspectConfigurationError,
  AspectNotReadyError,
  AspectUsageError,
} from "./errors";

describe("aspect errors", () => {
  it.each([
    ["AspectConfigurationError", AspectConfigurationError],
    ["AspectUsageError", AspectUsageError],
    ["AspectNotReadyError", AspectNotReadyError],
  ])("%s reports its class name", (name, ErrorClass) => {
    expect(String(new ErrorClass("invalid pointcut"))).toBe(
      `${name}: invalid pointcut`,
    );
  });
});
