export interface SendGridModuleOptions {
  /** SendGrid API key, sent as a Bearer token. Keys normally start with `SG.`. */
  apiKey: string;
  /** Regional API host. Defaults to `"global"`; use `"eu"` for EU-pinned subusers. */
  dataResidency?: "global" | "eu";
  /**
   * Default request timeout in milliseconds for every request of this
   * registration, from `0` (disabled) to `2147483647` (Node's timer limit).
   */
  timeout?: number;
  /** Subuser username sent in the `On-Behalf-Of` header of every request. */
  impersonateSubuser?: string;
}
