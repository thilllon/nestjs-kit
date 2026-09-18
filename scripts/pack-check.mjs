import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Inspect the actual tarball consumers install, not just the build directory.
for (const folder of readdirSync("packages")) {
  const directory = resolve("packages", folder);
  if (!existsSync(join(directory, "package.json"))) continue;
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (pkg.private) continue;
  const temporary = mkdtempSync(join(tmpdir(), "nestjs-kit-pack-"));
  try {
    const [packed] = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
        {
          cwd: directory,
          encoding: "utf8",
        },
      ),
    );
    const files = packed.files.map((file) => file.path);
    for (const required of [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "LICENSE",
    ])
      assert(files.includes(required), `${pkg.name} is missing ${required}`);
    assert(
      !files.some((file) =>
        /(?:\.spec\.|\.test\.|^src\/|^\.env|__fixtures?__)/.test(file),
      ),
      `${pkg.name} contains development files`,
    );
    execFileSync("tar", [
      "-xzf",
      join(temporary, packed.filename),
      "-C",
      temporary,
    ]);
    const extracted = join(temporary, "package");
    symlinkSync(
      join(directory, "node_modules"),
      join(extracted, "node_modules"),
      "dir",
    );
    const require = createRequire(join(extracted, "package.json"));
    require("reflect-metadata");
    const cjs = require(extracted);
    assert(Object.keys(cjs).length > 0, `${pkg.name} has no public exports`);
    const esm = await import(
      pathToFileURL(join(extracted, "dist/index.js")).href
    );
    assert(esm.default, `${pkg.name} cannot be imported from ESM`);
    console.log(
      `${pkg.name}@${pkg.version}: tarball, declarations and CJS/ESM imports verified`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
