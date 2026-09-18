import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

// A removed source file must not survive in the next published tarball.
rmSync("dist", { recursive: true, force: true });
execFileSync("tsc", ["-p", "tsconfig.json"], { stdio: "inherit" });
