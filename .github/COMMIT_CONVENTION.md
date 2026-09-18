# Commit convention

Use [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint locally and on PR titles. Pull requests are squash merged, so their titles become the commit message.

- `feat(s3): support multipart uploads` describes a feature.
- `fix(cloudinary): preserve upload errors` describes a fix.
- `feat(drizzle)!: replace connection API` marks a breaking change.
- A `BREAKING CHANGE:` footer also describes a breaking change.

Commit messages do not determine versions. Include an explicit Changeset with the affected packages and appropriate bump types for publishable changes. Use a major bump for breaking changes, minor for compatible features and patch for compatible fixes. README, tests, development dependencies and repository tooling alone do not require a Changeset.

See [the contribution guide](../CONTRIBUTING.md) and [release automation](../docs/releases.md). Do not add `Co-Authored-By` trailers.
