import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  scripts?: Record<string, string>;
  [field: string]: unknown;
}
interface ReleaseState {
  source: string;
}

export type ReleaseType = "major" | "minor" | "patch";
interface PackageChange {
  name: string;
  type: ReleaseType;
  summaries: string[];
}

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const json = <T,>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;
const fields = [
  "name",
  "dependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "engines",
  "exports",
  "main",
  "module",
  "types",
  "files",
  "type",
  "sideEffects",
  "scripts",
];
export function runtimeManifest(manifest: Partial<PackageManifest>): string {
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
export function releaseType(message: string): ReleaseType {
  if (/^[a-z]+(?:\([^\n]*\))?!:|^BREAKING[ -]CHANGE:/m.test(message))
    return "major";
  return /^feat(?:\([^\n]*\))?:/.test(message) ? "minor" : "patch";
}
export function isReleaseFile(path: string, directory: string): boolean {
  const relative = path.startsWith(`${directory}/`)
    ? path.slice(directory.length + 1)
    : "";
  if (
    !relative ||
    /^tsconfig\.(?:test|spec)(?:\.[^/]*)?\.json$/.test(relative) ||
    /(?:^|\/)(?:__tests__|test|tests|fixtures|__fixture__|__fixtures__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
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
export function highestRelease(types: ReleaseType[]): ReleaseType | undefined {
  return (["major", "minor", "patch"] as const).find((type) =>
    types.includes(type),
  );
}
function manifestAt(ref: string, directory: string): Partial<PackageManifest> {
  try {
    return JSON.parse(git("show", `${ref}:${directory}/package.json`));
  } catch {
    return {};
  }
}
export function planRelease() {
  const state = json<ReleaseState>(".changeset/release-state.json");
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
  const changes: PackageChange[] = [];
  for (const entry of readdirSync("packages", { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !existsSync(`packages/${entry.name}/package.json`)
    )
      continue;
    const directory = `packages/${entry.name}`;
    const manifest = json<PackageManifest>(`${directory}/package.json`);
    if (manifest.private) continue;
    const types: ReleaseType[] = [];
    const summaries: string[] = [];
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
          file === "tsdown.config.mts",
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
      summaries.push(message.split("\n")[0] ?? "");
    }
    const type = highestRelease(types);
    if (type)
      changes.push({
        name: manifest.name,
        type,
        summaries,
      });
  }
  return { changes, head };
}
export function prepare(): boolean {
  const { changes, head } = planRelease();
  const manualChangesets = readdirSync(".changeset").filter(
    (file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md",
  );
  if (!changes.length && !manualChangesets.length) return false;
  if (changes.length) {
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
  }
  execFileSync("pnpm", ["exec", "changeset", "version"], { stdio: "inherit" });
  writeFileSync(
    ".changeset/release-state.json",
    `${JSON.stringify({ source: head }, null, 2)}\n`,
  );
  execFileSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    stdio: "inherit",
  });
  execFileSync("pnpm", ["format"], { stdio: "inherit" });
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
