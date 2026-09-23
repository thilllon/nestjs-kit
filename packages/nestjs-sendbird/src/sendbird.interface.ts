import type { createConfiguration } from "@sendbird/sendbird-platform-sdk-typescript";

type SendbirdConfigurationParameters = NonNullable<
  Parameters<typeof createConfiguration>[0]
>;

export interface SendbirdModuleOptions {
  /** Sendbird application ID; requests go to `https://api-{appId}.sendbird.com`. */
  appId: string;
  /**
   * Master or secondary API token (visible ASCII) used when a call omits
   * `apiToken`. SDK methods whose request type requires `apiToken` never use it.
   */
  apiToken: string;
  /**
   * Advanced SDK configuration: a custom `baseServer`, `httpApi`, `middleware`
   * or `promiseMiddleware`. Authentication is owned by the registration.
   */
  configuration?: Omit<SendbirdConfigurationParameters, "authMethods">;
}
