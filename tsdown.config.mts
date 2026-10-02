// Each package's tsdown loads these options. The module imports nothing, so the
// repository root needs no bundler; the literal annotations keep the values
// assignable to tsdown's option types where a package configuration spreads
// them into `defineConfig`.
export const sharedBuildOptions = {
  cwd: process.cwd(),
  entry: ["src/index.ts"],
  format: ["esm", "cjs"] as ("esm" | "cjs")[],
  platform: "node" as const,
  target: "node24",
  fixedExtension: true,
  tsconfig: "tsconfig.json",
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: true as const },
  publint: { strict: true },
  attw: { level: "error" as const },
};

export default sharedBuildOptions;
