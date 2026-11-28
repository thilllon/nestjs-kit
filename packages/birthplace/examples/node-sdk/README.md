# Build identity in OpenTelemetry NodeSDK resources

A Node.js application that records its build with the [`birthplace`](../../README.md) CLI and loads that record into the resource of every span it exports. It needs no external services: spans go to the console.

## What it does

- `build` compiles the application to `dist`. `build:metadata` then runs `birthplace generate --output dist/birthplace.json --strict --host`, which records the service name and version from `package.json`, the Git revision of the checkout and the build machine. It is a separate script so that a cached `build` task cannot restore a birthplace file from an older commit.
- `src/telemetry.ts` creates a `NodeSDK` whose resource detectors start with `birthplaceDetector`, followed by the process, host and environment detectors that `resourceDetectors` would otherwise replace. `includeHostAttributes` exports the build machine as `birthplace.host.*` attributes next to the runtime `host.*` attributes.
- `src/main.ts` starts the SDK, ends one span and shuts the SDK down, which prints the span with its resource.

## Run

From the repository root:

```sh
pnpm install
pnpm exec turbo run build --filter birthplace-node-sdk-example
pnpm --filter birthplace-node-sdk-example build:metadata
pnpm --filter birthplace-node-sdk-example start
```

The Turbo build compiles `birthplace` before the example. The printed span's resource includes `service.name`, `service.version`, `vcs.ref.head.revision` and the `birthplace.host.*` attributes.

## Files

- `src/telemetry.ts` configures the SDK and its resource detectors.
- `src/main.ts` exports one span to the console.
- `src/telemetry.test.ts` writes a birthplace file with `collectBirthplace` and `writeBirthplace`, exports a span through `createTelemetry` and checks its resource. Run it from the repository root with `pnpm --filter birthplace-node-sdk-example test`.
- `src/packaging.test.ts` runs `build:metadata` and `start` against the built example and checks the printed resource. Run it after the Turbo build with `pnpm --filter birthplace-node-sdk-example test:packaging`.
