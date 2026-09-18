import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { validatePending } from "./release-publish.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const fields = [
  "name",
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "engines",
  "exports",
  "main",
  "types",
  "files",
  "type",
  "scripts",
];
export function runtimeManifest(manifest) {
  return JSON.stringify(
    Object.fromEntries(
      fields.map((field) => [
        field,
        field === "scripts"
          ? { build: manifest.scripts?.build }
          : manifest[field],
      ]),
    ),
  );
}
export function releaseType(message) {
  if (/^[a-z]+(?:\([^\n]*\))?!:|^BREAKING[ -]CHANGE:/m.test(message))
    return "major";
  return /^feat(?:\([^\n]*\))?:/.test(message) ? "minor" : "patch";
}
export function isReleaseFile(path, directory) {
  const relative = path.startsWith(`${directory}/`)
    ? path.slice(directory.length + 1)
    : "";
  if (
    !relative ||
    /(?:^|\/)(?:__tests__|test|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
      relative,
    )
  )
    return false;
  return (
    relative.startsWith("src/") ||
    relative === "package.json" ||
    /^tsconfig.*\.json$/.test(relative)
  );
}
export function highestRelease(types) {
  return ["major", "minor", "patch"].find((type) => types.includes(type));
}
function manifestAt(ref, directory) {
  try {
    return JSON.parse(git("show", `${ref}:${directory}/package.json`));
  } catch {
    return {};
  }
}
export function planRelease() {
  const state = json(".changeset/release-state.json");
  const head = git("rev-parse", "HEAD");
  git("merge-base", "--is-ancestor", state.source, head);
  const commits = git(
    "rev-list",
    "--reverse",
    "--first-parent",
    `${state.source}..${head}`,
  )
    .split("\n")
    .filter(Boolean);
  const changes = [];
  const manifests = [];
  for (const entry of readdirSync("packages", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `packages/${entry.name}`;
    const manifest = json(`${directory}/package.json`);
    manifests.push(manifest);
    if (manifest.private) continue;
    const types = [];
    const summaries = [];
    for (const commit of commits) {
      const files = git(
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        `${commit}^`,
        commit,
      ).split("\n");
      const relevant = files.filter(
        (file) =>
          isReleaseFile(file, directory) ||
          file === "tsconfig.base.json" ||
          file === "scripts/build-package.mjs",
      );
      if (!relevant.length) continue;
      if (
        relevant.every((file) => file === `${directory}/package.json`) &&
        runtimeManifest(manifestAt(`${commit}^`, directory)) ===
          runtimeManifest(manifestAt(commit, directory))
      )
        continue;
      const message = git("show", "-s", "--format=%B", commit);
      types.push(releaseType(message));
      summaries.push(message.split("\n")[0]);
    }
    if (types.length)
      changes.push({
        name: manifest.name,
        type: highestRelease(types),
        summaries,
      });
  }
  validatePending(manifests, state.pending ?? {});
  return { changes, head };
}
export function prepare() {
  const { changes, head } = planRelease();
  if (!changes.length) return false;
  const frontmatter = changes
    .map(({ name, type }) => `${JSON.stringify(name)}: ${type}`)
    .join("\n");
  const notes = changes
    .map(
      ({ name, summaries }) =>
        `- ${name}: ${[...new Set(summaries)].join("; ")}`,
    )
    .join("\n");
  writeFileSync(
    ".changeset/automated-release.md",
    `---\n${frontmatter}\n---\n\n${notes}\n`,
  );
  execFileSync("pnpm", ["exec", "changeset", "version"], { stdio: "inherit" });
  const pending = { ...json(".changeset/release-state.json").pending };
  for (const entry of readdirSync("packages", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = json(`packages/${entry.name}/package.json`);
    if (changes.some(({ name }) => name === manifest.name))
      pending[manifest.name] = manifest.version;
  }
  writeFileSync(
    ".changeset/release-state.json",
    `${JSON.stringify({ source: head, pending }, null, 2)}\n`,
  );
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    stdio: "inherit",
  });
  execFileSync(
    "pnpm",
    ["exec", "prettier", "--write", ".changeset", "packages", "pnpm-lock.yaml"],
    { stdio: "inherit" },
  );
  return true;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const changed = prepare();
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  console.log(
    changed ? "Prepared package releases." : "No publishable package changes.",
  );
}
