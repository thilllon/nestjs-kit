import type { UserConfig } from "@commitlint/types";

export default {
  extends: ["@commitlint/config-conventional"],
  // Dependabot capitalizes its generated subject, which subject-case rejects.
  ignores: [(message) => /^chore\(deps\): Bump /.test(message)],
} satisfies UserConfig;
