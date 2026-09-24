import { Injectable } from "@nestjs/common";
import sendgridClient from "@sendgrid/client";
import sendgridMail from "@sendgrid/mail";
import type { SendGridModuleOptions } from "./sendgrid.interface";

// The SDK typings describe only the process-wide default instances. Their
// classes are runtime properties of those default exports.
type SdkClient = typeof import("@sendgrid/client");
type SdkMailService = typeof import("@sendgrid/mail");
const { Client } = sendgridClient as unknown as { Client: new () => SdkClient };
const { MailService } = sendgridMail as unknown as {
  MailService: new () => SdkMailService;
};

const DATA_RESIDENCIES: readonly unknown[] = ["global", "eu"];

// Node's timer limit (2^31 - 1 ms).
const MAX_TIMEOUT = 2_147_483_647;

@Injectable()
export class SendGridService {
  /** Web API client owned by this registration. */
  readonly client: SdkClient;

  /** Mail Send service that sends through this registration's `client`. */
  readonly mail: SdkMailService;

  constructor(options: SendGridModuleOptions) {
    const { apiKey, dataResidency, timeout, impersonateSubuser } = options;
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new Error("SendGridModule requires a non-empty apiKey.");
    }
    if (
      dataResidency !== undefined &&
      !DATA_RESIDENCIES.includes(dataResidency)
    ) {
      throw new Error(
        `SendGridModule dataResidency must be "global" or "eu"; received ${JSON.stringify(dataResidency)}.`,
      );
    }
    // axios would drop a NaN timeout silently, reject Infinity on every
    // request, and a negative one crashes the process on the first request.
    // Node shortens a longer timer to 1 ms, so every request would time out.
    if (
      timeout !== undefined &&
      !(Number.isFinite(timeout) && timeout >= 0 && timeout <= MAX_TIMEOUT)
    ) {
      const received =
        typeof timeout === "number" ? String(timeout) : JSON.stringify(timeout);
      throw new Error(
        `SendGridModule timeout must be a number of milliseconds from 0 to ${MAX_TIMEOUT}; received ${received}.`,
      );
    }
    // Never configure the SDK's default instances: each registration owns a
    // separate client and a mail service bound to it.
    this.client = new Client();
    if (dataResidency !== undefined) {
      this.client.setDataResidency(dataResidency);
    }
    // setApiKey resets the base URL to the host of the region selected above.
    this.client.setApiKey(apiKey);
    if (impersonateSubuser !== undefined) {
      this.client.setImpersonateSubuser(impersonateSubuser);
    }
    this.mail = new MailService();
    this.mail.setClient(this.client);
    if (timeout !== undefined) {
      this.mail.setTimeout(timeout);
    }
  }
}
