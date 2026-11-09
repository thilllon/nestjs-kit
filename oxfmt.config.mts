import { defineConfig } from "oxfmt";

// oxfmt formats every file type in the repository, including Markdown and YAML.
export default defineConfig({
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  // Package manifests keep the repository's script and field order.
  sortPackageJson: false,
  ignorePatterns: [
    // Preserved design material is not reformatted.
    "packages/nestjskit__better-auth/docs/**/*.md",
  ],
});
