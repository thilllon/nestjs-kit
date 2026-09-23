import { Injectable } from "@nestjs/common";
import {
  AnnouncementApi,
  BotApi,
  type Configuration,
  createConfiguration,
  GroupChannelApi,
  MessageApi,
  MetadataApi,
  ModerationApi,
  OpenChannelApi,
  type RequestContext,
  type SecurityAuthentication,
  ServerConfiguration,
  StatisticsApi,
  UserApi,
} from "@sendbird/sendbird-platform-sdk-typescript";
import type { SendbirdModuleOptions } from "./sendbird.interface";

/** The SDK's default server template, instantiated per registration. */
const SENDBIRD_API_URL = "https://api-{app_id}.sendbird.com";
const API_TOKEN_HEADER = "api-token";
/** Application IDs become a DNS label in the API host. */
const APP_ID_PATTERN = /^[A-Za-z0-9-]+$/;
/**
 * API tokens are sent as a header. Visible ASCII rejects a trailing newline from
 * a secret file, which the HTTP client would otherwise report per request with
 * the token in its error message.
 */
const API_TOKEN_PATTERN = /^[\x21-\x7e]+$/;

@Injectable()
export class SendbirdService {
  readonly configuration: Configuration;
  readonly announcements: AnnouncementApi;
  readonly bots: BotApi;
  readonly groupChannels: GroupChannelApi;
  readonly messages: MessageApi;
  readonly metadata: MetadataApi;
  readonly moderation: ModerationApi;
  readonly openChannels: OpenChannelApi;
  readonly statistics: StatisticsApi;
  readonly users: UserApi;

  constructor(options: SendbirdModuleOptions) {
    const { appId, apiToken, configuration = {} } = options;
    if (typeof appId !== "string" || !APP_ID_PATTERN.test(appId)) {
      throw new Error(
        "SendbirdModule requires an appId containing only letters, digits and hyphens",
      );
    }
    if (typeof apiToken !== "string" || !API_TOKEN_PATTERN.test(apiToken)) {
      // Never echo the value: it is a credential.
      throw new Error(
        "SendbirdModule requires a non-empty apiToken of visible ASCII characters, without whitespace or control characters",
      );
    }
    this.configuration = createConfiguration({
      ...configuration,
      baseServer:
        configuration.baseServer ??
        new ServerConfiguration(SENDBIRD_API_URL, { app_id: appId }),
      // The SDK appends promise middleware to this array; never share the caller's.
      middleware: [...(configuration.middleware ?? [])],
      authMethods: { default: registrationToken(apiToken) },
    });
    this.announcements = new AnnouncementApi(this.configuration);
    this.bots = new BotApi(this.configuration);
    this.groupChannels = new GroupChannelApi(this.configuration);
    this.messages = new MessageApi(this.configuration);
    this.metadata = new MetadataApi(this.configuration);
    this.moderation = new ModerationApi(this.configuration);
    this.openChannels = new OpenChannelApi(this.configuration);
    this.statistics = new StatisticsApi(this.configuration);
    this.users = new UserApi(this.configuration);
  }
}

/**
 * Fills the API token header only when the call omitted `apiToken`, so an
 * explicit per-call token (including an empty one) always wins. The SDK passes
 * an `undefined` or `null` token through as an omitted one.
 */
function registrationToken(apiToken: string): SecurityAuthentication {
  return {
    getName: () => API_TOKEN_HEADER,
    applySecurityAuthentication(context: RequestContext): void {
      const headers = context.getHeaders();
      // Generated methods spell the header either "api-token" or "Api-Token".
      const name =
        Object.keys(headers).find(
          (key) => key.toLowerCase() === API_TOKEN_HEADER,
        ) ?? API_TOKEN_HEADER;
      if (headers[name] == null) {
        context.setHeaderParam(name, apiToken);
      }
    },
  };
}
