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

test("real Changesets combines manual and automatic bumps and checkpoints manual-only releases", async () => {
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
    const source = commit("feat(one)!: replace public API");
    assert.match(prepare(), /Prepared package releases/);
    assert.equal(read("packages/one/package.json").version, "2.0.0");
    assert.equal(read("packages/two/package.json").version, "2.0.0");
    assert.deepEqual(read(".changeset/release-state.json"), { source });
    commit("chore(release): version changed packages");
    assert.match(prepare(), /No publishable package changes/);
    write(
      ".changeset/manual-only.md",
      '---\n"two": patch\n---\n\nManual-only release request.\n',
    );
    const manualSource = commit("chore: request manual package release");
    assert.match(prepare(), /Prepared package releases/);
    assert.equal(read("packages/one/package.json").version, "2.0.0");
    assert.equal(read("packages/two/package.json").version, "2.0.1");
    assert.deepEqual(read(".changeset/release-state.json"), {
      source: manualSource,
    });
    commit("chore(release): version manual request");
    assert.match(prepare(), /No publishable package changes/);
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("native publication skips existing versions and recovers a partial release and missing tags", async () => {
  const { execFile, execFileSync } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { createServer } = await import("node:http");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const cli = fileURLToPath(import.meta.resolve("@changesets/cli/bin.js"));
  const temp = mkdtempSync(join(tmpdir(), "nestjs-kit-native-publish-"));
  const workspace = join(temp, "workspace");
  const remote = join(temp, "remote.git");
  mkdirSync(workspace);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (path: string, value: unknown) =>
    writeFileSync(
      join(workspace, path),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  interface RegistryPackage {
    name: string;
    "dist-tags": { latest: string };
    versions: Record<
      string,
      {
        name: string;
        version: string;
        dist?: { tarball: string; shasum: string };
      }
    >;
  }
  const registryPackages = new Map<string, RegistryPackage>();
  for (const name of ["changed", "retry", "unchanged"]) {
    registryPackages.set(name, {
      name,
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name,
          version: "1.0.0",
          dist: {
            tarball: "http://127.0.0.1/fixture.tgz",
            shasum: "0".repeat(40),
          },
        },
      },
    });
  }
  const uploads: string[] = [];
  const lookups: string[] = [];
  let failRetry = true;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const name = decodeURIComponent(
      new URL(request.url ?? "/", "http://localhost").pathname.slice(1),
    );
    if (request.method === "GET") {
      lookups.push(name);
      const metadata = registryPackages.get(name);
      response.writeHead(metadata ? 200 : 404);
      response.end(JSON.stringify(metadata ?? { error: "not_found" }));
      return;
    }
    if (request.method !== "PUT" || !registryPackages.has(name)) {
      response.writeHead(405);
      response.end(JSON.stringify({ error: "unexpected_fixture_request" }));
      return;
    }
    uploads.push(name);
    if (name === "retry" && failRetry) {
      failRetry = false;
      response.writeHead(403);
      response.end(JSON.stringify({ error: "fixture_publish_failure" }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    const incoming = JSON.parse(body) as RegistryPackage;
    const previous = registryPackages.get(name);
    registryPackages.set(name, {
      ...incoming,
      versions: { ...previous?.versions, ...incoming.versions },
    });
    response.writeHead(201);
    response.end(JSON.stringify({ ok: true }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const registry = `http://127.0.0.1:${address.port}/`;
    git("init", "-q");
    git("config", "user.name", "Release Test");
    git("config", "user.email", "test@example.com");
    git("init", "--bare", "-q", remote);
    git("remote", "add", "origin", remote);
    mkdirSync(join(workspace, ".changeset"));
    write("package.json", {
      name: "release-fixture",
      private: true,
    });
    write(
      "pnpm-workspace.yaml",
      "packages:\n  - packages/*\nfetchRetries: 0\n",
    );
    write(
      ".npmrc",
      `registry=${registry}\n//127.0.0.1:${address.port}/:_authToken=local-fixture\n`,
    );
    write("empty-user.npmrc", "");
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
    for (const name of ["changed", "retry", "unchanged", "private-fixture"]) {
      mkdirSync(join(workspace, "packages", name), { recursive: true });
      write(`packages/${name}/package.json`, {
        name,
        version: name === "changed" || name === "retry" ? "2.0.0" : "1.0.0",
        private: name === "private-fixture",
        files: ["index.js"],
        publishConfig: { registry, access: "public", provenance: false },
      });
      write(`packages/${name}/index.js`, "module.exports = {};\n");
    }
    git("add", ".");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "chore(release): fixture versions",
    );
    git("tag", "-a", "unchanged@1.0.0", "-m", "existing release");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "true",
      LEFTHOOK: "0",
      NPM_CONFIG_USERCONFIG: join(workspace, "empty-user.npmrc"),
      NPM_CONFIG_REGISTRY: registry,
      PNPM_CONFIG_REGISTRY: registry,
    };
    delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const run = (...args: string[]) =>
      promisify(execFile)(process.execPath, [cli, ...args], {
        cwd: workspace,
        env,
        timeout: 30000,
      });
    let firstFailure = "";
    await assert.rejects(run("publish"), (error: unknown) => {
      assert.ok(
        error instanceof Error && "stdout" in error && "stderr" in error,
      );
      firstFailure = String(error.stdout) + String(error.stderr);
      return true;
    });
    assert.ok(registryPackages.get("changed")?.versions["2.0.0"], firstFailure);
    assert.equal(registryPackages.get("retry")?.versions["2.0.0"], undefined);
    await run("publish");
    assert.deepEqual(
      uploads.filter((name) => name === "changed"),
      ["changed"],
    );
    assert.deepEqual(
      uploads.filter((name) => name === "retry"),
      ["retry", "retry"],
    );
    assert.equal(
      uploads.includes("unchanged"),
      false,
      JSON.stringify({ lookups, uploads, firstFailure }),
    );
    assert.equal(lookups.includes("private-fixture"), false);
    // Native publish skips already-published public versions; git-tag repairs their tags.
    git("tag", "-d", "changed@2.0.0");
    await run("publish");
    assert.equal(git("tag", "--list", "changed@2.0.0"), "");
    await run("git-tag");
    const releaseHead = git("rev-parse", "HEAD");
    assert.equal(git("rev-parse", "changed@2.0.0^{commit}"), releaseHead);
    assert.equal(git("tag", "--list", "private-fixture@1.0.0"), "");
    git("push", "origin", "--tags");
    const remoteTags = git("ls-remote", "--tags", "origin");
    assert.match(remoteTags, /refs\/tags\/changed@2\.0\.0/);
    assert.match(remoteTags, /refs\/tags\/retry@2\.0\.0/);
    const uploadCount = uploads.length;
    write("README.md", "Documentation only.\n");
    git("add", "README.md");
    git(
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "docs: update example",
    );
    await run("publish");
    await run("git-tag");
    assert.equal(uploads.length, uploadCount);
    assert.equal(git("rev-parse", "changed@2.0.0^{commit}"), releaseHead);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
});
