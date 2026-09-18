import assert from "node:assert/strict";
import test from "node:test";
import {
  highestRelease,
  isReleaseFile,
  releaseType,
  runtimeManifest,
} from "./release-prepare.mjs";

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
    runtimeManifest({ ...base, dependencies: { sdk: "^2" } }),
  );
});

test("git history accumulates package changes and skips consumed releases", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { planRelease } = await import("./release-prepare.mjs");
  const original = process.cwd();
  const temp = mkdtempSync(join(tmpdir(), "nestjs-kit-release-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: temp, encoding: "utf8" }).trim();
  const write = (path, value) =>
    writeFileSync(
      join(temp, path),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  const commit = (message) => {
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
    mkdirSync(join(temp, ".changeset"));
    const baseline = commit("chore: initial");
    write(".changeset/release-state.json", { source: baseline });
    write("README.md", "docs");
    commit("docs: explain setup");
    process.chdir(temp);
    assert.deepEqual(planRelease().changes, []);
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
    write("scripts/build-package.mjs", "// shared clean build\n");
    const build = commit("build: clean package outputs before compiling");
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
  const { shouldPublish } = await import("./release-publish.mjs");
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
  const { validatePending } = await import("./release-publish.mjs");
  assert.throws(
    () => validatePending([], { removed: "1.0.0" }),
    /removed or made private/,
  );
  assert.throws(
    () =>
      validatePending([{ name: "private", private: true }], {
        private: "1.0.0",
      }),
    /removed or made private/,
  );
  assert.doesNotThrow(() =>
    validatePending([{ name: "unreleased", version: "0.0.0" }], {}),
  );
});

test("tag recovery retries a failed push without recreating its local tag", async () => {
  const { recoverTag } = await import("./release-publish.mjs");
  const head = "a".repeat(40);
  let tagExists = false;
  let createCount = 0;
  let pushCount = 0;
  const git = (...args) => {
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
