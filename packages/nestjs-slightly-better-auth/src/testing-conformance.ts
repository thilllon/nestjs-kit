export type {
  ConformanceCase,
  ConformanceOutcome,
  ConformanceRunner,
  ConformanceSkip,
} from "./auth-contracts.js";
export {
  conformanceProbePlugin,
  createConformanceAuth,
  PROBE_TRUSTED_ORIGIN,
  runConformance,
} from "./conformance-fixtures.js";
export {
  type HttpConformanceOptions,
  httpPlatformConformance,
} from "./conformance-http.js";
export {
  type PolicyConformanceOptions,
  policyConformance,
} from "./conformance-policy.js";
export {
  type ConformanceApiKey,
  type PrincipalHttpConformanceOptions,
  type PrincipalSourceConformanceOptions,
  principalSourceConformance,
} from "./conformance-principal.js";
export {
  type ConnectionAuthenticationResult,
  type FixtureContext,
  type FixtureHandler,
  type GraphFixtures,
  type GraphqlContextShape,
  type GraphResult,
  type GraphSelection,
  type InheritedFixture,
  type InvocationShape,
  type TransportConformanceOptions,
  type TransportFixtures,
  type TransportInvocationResult,
  transportConformance,
} from "./conformance-transport.js";
