# birthplace

The root `AGENTS.md` applies. These rules cover what is specific to this package.

## Scope

- birthplace captures build metadata at build time and reads the packaged record at run time. The runtime detector never invokes Git, reads `package.json`, regenerates metadata or mutates `process.env`.
- `birthplace/otel` loads neither the Git collector (`child_process`) nor the build-machine collector (`os`), and `birthplace/attributes` loads no Node.js built-in. `src/packaging.test.ts` checks both in each module format.
- A birthplace file describes one build and stays immutable after capture; deployment environment and deployment time do not belong in it.
- Prefer standard OTel attributes; custom `birthplace.*` attributes stay opt-in. When a mapping changes, record the semantic-conventions version it was checked against and each attribute's stability level in the README and in `src/otel-attributes.ts`.
- OpenTelemetry packages are development dependencies only; `commander` is the only runtime dependency.
- The package supports Node.js 22 and later. tsdown targets `node22`, and CI runs the packaging tests, Vitest included, on the `engines.node` floor, Node.js 22.0.0. Vitest, Vite and rolldown declare Node.js 22.12.0 as their minimum, so a tooling update can break that job; raising the floor narrows a runtime requirement and needs a major Changeset.

## Tests

- Discovery tests use real temporary Git repositories and isolated environments. CI provider variables, `SOURCE_DATE_EPOCH` and generated files must not leak into fixture identity.
- `src/packaging.test.ts` runs the built CLI as subprocesses, exports spans from a real NodeSDK through `fixtures/node-sdk-smoke.mts`, and installs the packed archive into a consumer outside the workspace. The fixture runs in its own process because it patches `Module._load` and changes the working directory.
- `examples/node-sdk` is a private workspace application. Its unit test runs against the package source, and its packaging test runs the documented `build:metadata` and `start` scripts against the built package.
