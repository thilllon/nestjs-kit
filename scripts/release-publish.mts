import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  scripts?: Record<string, string>;
  [field: string]: unknown;
}

export type PendingReleases = Record<string, string>;
export interface ReleaseState {
  source: string;
  pending?: PendingReleases;
}
interface RegistryMetadata {
  versions?: Record<string, { gitHead?: string }>;
}

export function shouldPublish(
  pkg: PackageManifest,
  pending: PendingReleases,
): boolean {
  if (pkg.private || !pending[pkg.name]) return false;
  if (pkg.version !== pending[pkg.name] || pkg.version === "0.0.0")
    throw new Error(
      `Invalid release plan version for ${pkg.name}: ${pkg.version}`,
    );
  return true;
}

export function validatePending(
  packages: PackageManifest[],
  pending: PendingReleases,
): void {
  for (const name of Object.keys(pending)) {
    const pkg = packages.find((pkg) => pkg.name === name);
    if (!pkg || pkg.private)
      throw new Error(
        `Planned package ${name} was removed or made private. Retire its pending release explicitly before continuing.`,
      );
    shouldPublish(pkg, pending);
  }
}

export function selectReleases<T extends PackageManifest>(
  packages: T[],
  pending: PendingReleases,
  selection?: string,
): T[] {
  validatePending(packages, pending);
  const planned = packages.filter((pkg) => shouldPublish(pkg, pending));
  if (selection === undefined || selection === "") return planned;
  const names = new Set(selection.split(",").map((name) => name.trim()));
  for (const name of names) {
    if (!name || !planned.some((pkg) => pkg.name === name))
      throw new Error(
        `Package ${JSON.stringify(name)} is not in the validated publication plan`,
      );
  }
  return planned.filter((pkg) => names.has(pkg.name));
}

export function recoverTag(
  tag: string,
  target: string | undefined,
  git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8" }).trim(),
) {
  if (!target) {
    console.log(
      `Cannot reconstruct ${tag}: npm has no gitHead; no tag was invented.`,
    );
    return;
  }
  if (!/^[a-f0-9]{40,64}$/.test(target))
    throw new Error(`Invalid registry gitHead for ${tag}`);
  const existing = git("tag", "--list", tag);
  if (existing) {
    if (git("rev-parse", `${tag}^{commit}`) !== target)
      throw new Error(`Existing tag ${tag} points at a different commit`);
  } else {
    git("tag", tag, target);
  }
  // Push even when a local tag exists: an earlier run may have failed at this step.
  git("push", "origin", `refs/tags/${tag}`);
}

export async function publish(): Promise<void> {
  if (process.env.NPM_PUBLISH_ENABLED !== "true")
    throw new Error(
      "Publishing is disabled. Configure npm trusted publishers before enabling NPM_PUBLISH_ENABLED.",
    );
  const { pending = {} } = JSON.parse(
    readFileSync(".changeset/release-state.json", "utf8"),
  ) as ReleaseState;
  const packages = readdirSync("packages", { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(`packages/${entry.name}/package.json`),
    )
    .map((entry) => ({
      ...(JSON.parse(
        readFileSync(`packages/${entry.name}/package.json`, "utf8"),
      ) as PackageManifest),
      directory: `packages/${entry.name}`,
    }));
  const selected = selectReleases(
    packages,
    pending,
    process.env.NPM_PUBLISH_PACKAGES,
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  for (const pkg of selected) {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`,
    );
    if (response.status !== 404 && !response.ok)
      throw new Error(
        `Registry lookup failed: ${pkg.name} (${response.status})`,
      );
    const metadata: RegistryMetadata =
      response.status === 404
        ? {}
        : ((await response.json()) as RegistryMetadata);
    const published = metadata.versions?.[pkg.version];
    if (published) {
      console.log(`Already published: ${pkg.name}@${pkg.version}`);
    } else {
      execFileSync("npm", ["publish", "--access", "public", "--provenance"], {
        cwd: pkg.directory,
        stdio: "inherit",
      });
    }
    recoverTag(
      `${pkg.name}@${pkg.version}`,
      published ? published.gitHead : head,
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await publish();
