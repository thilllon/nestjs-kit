import { spawnSync } from "node:child_process";

if (!process.env.CI) {
  const result = spawnSync("mise", ["exec", "--", "lefthook", "install"], {
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    console.error("Install mise tools, then run pnpm hooks:install.");
    process.exitCode = 1;
  }
}
