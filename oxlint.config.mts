import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
  },
  rules: {
    curly: ["error", "all"],
    "prefer-rest-params": "error",
    "typescript/no-empty-interface": "error",
    "typescript/no-unsafe-function-type": "error",
    "no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      },
    ],
    // Spreading an iterator snapshots it before the loop mutates its source.
    "unicorn/no-useless-spread": "off",
    // Tests send malformed requests on purpose.
    "unicorn/no-invalid-fetch-options": "off",
    "unicorn/no-useless-fallback-in-spread": "off",
    "unicorn/prefer-string-starts-ends-with": "off",
  },
});
