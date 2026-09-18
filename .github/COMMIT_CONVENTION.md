# Commit convention

Use [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint locally and on PR titles. Pull requests are squash merged, so their titles determine the release message.

- `feat(s3): support multipart uploads` → minor release of affected packages.
- `fix(cloudinary): preserve upload errors` → patch release.
- `feat(drizzle)!: replace connection API` → major release.
- A `BREAKING CHANGE:` footer also requests a major release.

Only publishable package changes trigger releases. Source changes, runtime manifest changes, and package compiler configuration changes count; README, tests, development dependencies, and repository tooling alone do not. Other commit types that change publishable code produce patch releases.

See [the contribution guide](../CONTRIBUTING.md) and [release automation](../docs/releases.md). Do not add `Co-Authored-By` trailers.
