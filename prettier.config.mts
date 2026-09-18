import type { Config } from "prettier";

// Biome owns its supported languages; Prettier handles Markdown and YAML.
export default {
  useTabs: false,
  tabWidth: 2,
  trailingComma: "all",
  singleQuote: false,
} satisfies Config;
