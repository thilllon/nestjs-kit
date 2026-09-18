import assert from "node:assert/strict";
import test from "node:test";
import {
  highestRelease,
  isReleaseFile,
  releaseType,
  runtimeManifest,
} from "./release-prepare.mts";

test("conventional commits choose independent semantic versions", () => {
  assert.equal(releaseType("feat(s3): support multipart"), "minor");
  assert.equal(releaseType("fix: correct injection"), "patch");
  assert.equal(releaseType("feat(s3)!: replace API"), "major");
  assert.equal(releaseType("feat!: require Node.js 24 and NestJS 12"), "major");
  assert.equal(
    releaseType("refactor: migrate\n\nBREAKING CHANGE: Node 24 required"),
    "major",
  );
  assert.equal(highestRelease(["patch", "major", "minor"]), "major");
});
test("docs, tests and unrelated packages do not trigger publishing", () => {
  const dir = "packages/nestjskit__s3";
  for (const file of [
    "README.md",
    ".github/workflows/ci.yml",
    `${dir}/README.md`,
    `${dir}/src/client.spec.ts`,
    `${dir}/src/client.test.ts`,
    `${dir}/tsconfig.test.json`,
    `${dir}/src/fixtures/example.ts`,
    `${dir}/src/__fixture__/legacy.ts`,
    `${dir}/src/__fixtures__/legacy.ts`,
    `${dir}/src/__tests__/client.ts`,
    "packages/nestjskit__cloudinary/src/index.ts",
  ])
    assert.equal(isReleaseFile(file, dir), false, file);
  assert.equal(isReleaseFile(`${dir}/src/index.ts`, dir), true);
  assert.equal(isReleaseFile(`${dir}/tsconfig.json`, dir), true);
});
test("version-only and development-only manifest changes do not release", () => {
  const base = {
    name: "example",
    version: "1.0.0",
    dependencies: { sdk: "^1" },
    devDependencies: { test: "1" },
    scripts: { build: "tsc", test: "old" },
  };
  assert.equal(
    runtimeManifest(base),
    runtimeManifest({
      ...base,
      version: "1.0.1",
      devDependencies: { test: "2" },
      scripts: { build: "tsc", test: "new" },
    }),
  );
  assert.notEqual(
    runtimeManifest(base),
    runtimeManifest({ ...base, module: "./dist/index.mjs" }),
  );
  for (const metadata of [
    { sideEffects: false },
    { peerDependenciesMeta: { sdk: { optional: true } } },
  ]) {
    assert.notEqual(
      runtimeManifest(base),
      runtimeManifest({ ...base, ...metadata }),
    );
  }
  assert.notEqual(
    runtimeManifest(base),
    runtimeManifest({ ...base, dependencies: { sdk: "^2" } }),
  );
});

test("git history accumulates package changes and skips consumed releases", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { planRelease } = await import("./release-prepare.mts");
  const original = process.cwd();
  const temp = mkdtempSync(join(tmpdir(), "nestjs-kit-release-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: temp, encoding: "utf8" }).trim();
  const write = (path: string, value: unknown) =>
    writeFileSync(
      join(temp, path),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const commit = (message: string) => {
    git("add", ".");
    git(
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    for (const name of ["one", "two"]) {
      mkdirSync(join(temp, "packages", name, "src"), { recursive: true });
      write(`packages/${name}/package.json`, { name, version: "1.0.0" });
      write(`packages/${name}/src/index.ts`, "export {};");
    }
    mkdirSync(join(temp, "packages", "orphan", "node_modules"), {
      recursive: true,
    });
    mkdirSync(join(temp, ".changeset"));
    const baseline = commit("chore: initial");
    write(".changeset/release-state.json", { source: baseline });
    write("README.md", "docs");
    commit("docs: explain setup");
    process.chdir(temp);
    assert.deepEqual(planRelease().changes, []);
    // Empty pending state must skip orphan directories without registry access.
    const { publish } = await import("./release-publish.mts");
    const previousGate = process.env.NPM_PUBLISH_ENABLED;
    const previousFetch = globalThis.fetch;
    process.env.NPM_PUBLISH_ENABLED = "true";
    globalThis.fetch = () => {
      throw new Error("Unexpected registry request for an empty release plan");
    };
    try {
      await publish();
    } finally {
      if (previousGate === undefined) delete process.env.NPM_PUBLISH_ENABLED;
      else process.env.NPM_PUBLISH_ENABLED = previousGate;
      globalThis.fetch = previousFetch;
    }
    write("packages/one/src/index.ts", "export const one = 1;");
    commit("feat(one): expose one");
    write("packages/two/src/index.ts", "export const two = 2;");
    const source = commit("fix(two)!: replace API");
    assert.deepEqual(
      planRelease().changes.map(({ name, type }) => ({ name, type })),
      [
        { name: "one", type: "minor" },
        { name: "two", type: "major" },
      ],
    );
    write(".changeset/release-state.json", { source });
    write("packages/one/package.json", { name: "one", version: "1.1.0" });
    commit("chore(release): version changed packages");
    assert.deepEqual(planRelease().changes, []);
    write("packages/one/package.json", {
      name: "one",
      version: "1.1.0",
      devDependencies: { vitest: "5" },
    });
    const devOnly = commit("chore(deps): update vitest");
    assert.deepEqual(planRelease().changes, []);
    write(".changeset/release-state.json", { source: devOnly });
    write("packages/two/package.json", {
      name: "two",
      version: "1.0.0",
      dependencies: { sdk: "^2" },
    });
    const dependency = commit("chore(deps): update sdk");
    assert.deepEqual(
      planRelease().changes.map(({ name, type }) => ({ name, type })),
      [{ name: "two", type: "patch" }],
    );
    write(".changeset/release-state.json", { source: dependency });
    rmSync(join(temp, "packages/one/src/index.ts"));
    const deletion = commit("fix(one): remove broken export");
    assert.deepEqual(
      planRelease().changes.map(({ name }) => name),
      ["one"],
    );
    write(".changeset/release-state.json", { source: deletion });
    write("tsconfig.base.json", { compilerOptions: { target: "ES2023" } });
    const shared = commit("build: update shared compiler target");
    assert.deepEqual(
      planRelease().changes.map(({ name }) => name),
      ["one", "two"],
    );
    write(".changeset/release-state.json", { source: shared });
    mkdirSync(join(temp, "scripts"));
    write("tsdown.config.mts", "// shared bundle configuration\n");
    const build = commit("build: update shared tsdown configuration");
    assert.deepEqual(
      planRelease().changes.map(({ name }) => name),
      ["one", "two"],
    );
    write(".changeset/release-state.json", { source: build });
    mkdirSync(join(temp, "packages/nestjs-pg-listen/src"), { recursive: true });
    write("packages/nestjs-pg-listen/package.json", {
      name: "nestjs-pg-listen",
      version: "0.0.0",
    });
    write("packages/nestjs-pg-listen/src/index.ts", "export {};");
    commit("feat(pg-listen): introduce PostgreSQL notifications");
    assert.deepEqual(
      planRelease().changes.map(({ name, type }) => ({ name, type })),
      [{ name: "nestjs-pg-listen", type: "minor" }],
    );
  } finally {
    process.chdir(original);
    rmSync(temp, { recursive: true, force: true });
  }
});

test("publication only accepts explicitly versioned packages in the persisted plan", async () => {
  const { shouldPublish } = await import("./release-publish.mts");
  assert.equal(shouldPublish({ name: "new", version: "0.0.0" }, {}), false);
  assert.equal(
    shouldPublish({ name: "existing", version: "1.0.0" }, { other: "1.0.0" }),
    false,
  );
  assert.equal(
    shouldPublish(
      { name: "existing", version: "1.1.0" },
      { existing: "1.1.0" },
    ),
    true,
  );
  assert.throws(
    () => shouldPublish({ name: "new", version: "0.0.0" }, { new: "0.0.0" }),
    /Invalid release plan/,
  );
  assert.throws(
    () =>
      shouldPublish(
        { name: "existing", version: "1.0.0" },
        { existing: "1.1.0" },
      ),
    /Invalid release plan/,
  );
});

test("removed or private planned packages fail before any publication", async () => {
  const { validatePending } = await import("./release-publish.mts");
  assert.throws(
    () => validatePending([], { removed: "1.0.0" }),
    /removed or made private/,
  );
  assert.throws(
    () =>
      validatePending([{ name: "private", version: "1.0.0", private: true }], {
        private: "1.0.0",
      }),
    /removed or made private/,
  );
  assert.doesNotThrow(() =>
    validatePending([{ name: "unreleased", version: "0.0.0" }], {}),
  );
});

test("publication selection leaves other pending versions available for retry", async () => {
  const { selectReleases } = await import("./release-publish.mts");
  const packages = [
    { name: "@scope/one", version: "1.0.0", directory: "packages/one" },
    { name: "two", version: "2.0.0", directory: "packages/two" },
    { name: "unchanged", version: "1.0.0", directory: "packages/unchanged" },
    {
      name: "private",
      version: "1.0.0",
      private: true,
      directory: "packages/private",
    },
  ];
  const pending = Object.freeze({ "@scope/one": "1.0.0", two: "2.0.0" });
  assert.deepEqual(selectReleases(packages, pending), packages.slice(0, 2));
  assert.deepEqual(selectReleases(packages, pending, ""), packages.slice(0, 2));
  assert.deepEqual(selectReleases(packages, pending, " two, two "), [
    packages[1],
  ]);
  assert.deepEqual(selectReleases(packages, pending, "@scope/one"), [
    packages[0],
  ]);
  for (const selection of ["unknown", "unchanged", "private", "two,", " "]) {
    assert.throws(
      () => selectReleases(packages, pending, selection),
      /not in the validated publication plan/,
    );
  }
  assert.throws(
    () => selectReleases(packages, { ...pending, two: "3.0.0" }, "@scope/one"),
    /Invalid release plan version/,
  );
});

test("tag recovery retries a failed push without recreating its local tag", async () => {
  const { recoverTag } = await import("./release-publish.mts");
  const head = "a".repeat(40);
  let tagExists = false;
  let createCount = 0;
  let pushCount = 0;
  const git = (...args: string[]) => {
    if (args[0] === "tag" && args[1] === "--list")
      return tagExists ? "pkg@1.0.0" : "";
    if (args[0] === "rev-parse") return head;
    if (args[0] === "tag") {
      tagExists = true;
      createCount++;
      return "";
    }
    if (args[0] === "push") {
      pushCount++;
      if (pushCount === 1) throw new Error("network unavailable");
      return "";
    }
    throw new Error(`Unexpected git command: ${args}`);
  };
  assert.throws(
    () => recoverTag("pkg@1.0.0", head, git),
    /network unavailable/,
  );
  recoverTag("pkg@1.0.0", head, git);
  assert.equal(createCount, 1);
  assert.equal(pushCount, 2);
  assert.throws(
    () => recoverTag("pkg@1.0.0", "b".repeat(40), git),
    /different commit/,
  );
});

test("real Changesets combines manual and automatic bumps and supports manual-only releases", async () => {
  const { execFileSync } = await import("node:child_process");
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    symlinkSync,
    rmSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(import.meta.resolve("@changesets/cli/bin.js"));
  const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
  const prepareScript = fileURLToPath(
    new URL("./release-prepare.mts", import.meta.url),
  );
  const temp = mkdtempSync(join(tmpdir(), "nestjs-kit-changesets-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: temp, encoding: "utf8" }).trim();
  const write = (path: string, value: unknown) =>
    writeFileSync(
      join(temp, path),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const read = (path: string) =>
    JSON.parse(readFileSync(join(temp, path), "utf8")) as Record<
      string,
      unknown
    >;
  const commit = (message: string) => {
    git("add", ".");
    git(
      "-c",
      "user.name=Release Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  const prepare = () =>
    execFileSync(process.execPath, [tsxCli, prepareScript], {
      cwd: temp,
      encoding: "utf8",
      env: { ...process.env, CI: "true", LEFTHOOK: "0" },
    });
  try {
    git("init", "-q");
    mkdirSync(join(temp, "node_modules/.bin"), { recursive: true });
    symlinkSync(cli, join(temp, "node_modules/.bin/changeset"));
    mkdirSync(join(temp, ".changeset"));
    mkdirSync(join(temp, "packages/orphan/node_modules"), { recursive: true });
    write(".gitignore", "node_modules/\n");
    write("package.json", {
      name: "release-fixture",
      private: true,
      packageManager: "pnpm@12.4.2",
      scripts: { format: 'node --eval ""' },
    });
    write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write(".changeset/config.json", {
      changelog: false,
      commit: false,
      fixed: [],
      linked: [],
      access: "public",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      ignore: [],
    });
    for (const name of ["one", "two"]) {
      mkdirSync(join(temp, "packages", name, "src"), { recursive: true });
      write(`packages/${name}/package.json`, { name, version: "1.0.0" });
      write(`packages/${name}/src/index.ts`, "export {};\n");
    }
    const baseline = commit("chore: initial fixture");
    write(".changeset/release-state.json", { source: baseline });
    write("packages/one/src/index.ts", "export const changed = true;\n");
    write(
      ".changeset/major.md",
      '---\n"one": major\n"two": major\n---\n\nExplicit major release.\n',
    );
    commit("feat(one)!: replace public API");
    assert.match(prepare(), /Prepared package releases/);
    assert.equal(read("packages/one/package.json").version, "2.0.0");
    assert.equal(read("packages/two/package.json").version, "2.0.0");
    assert.deepEqual(read(".changeset/release-state.json").pending, {
      one: "2.0.0",
      two: "2.0.0",
    });
    commit("chore(release): version changed packages");
    assert.match(prepare(), /No publishable package changes/);
    write(
      ".changeset/manual-only.md",
      '---\n"two": patch\n---\n\nManual-only release request.\n',
    );
    commit("chore: request manual package release");
    assert.match(prepare(), /Prepared package releases/);
    assert.equal(read("packages/one/package.json").version, "2.0.0");
    assert.equal(read("packages/two/package.json").version, "2.0.1");
    assert.deepEqual(read(".changeset/release-state.json").pending, {
      one: "2.0.0",
      two: "2.0.1",
    });
    commit("chore(release): version manual request");
    assert.match(prepare(), /No publishable package changes/);
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
