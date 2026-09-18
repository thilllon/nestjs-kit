import type { MailDefaults, Transport, TransportConfig } from "nodemailer";

export interface NodemailerModuleOptions {
  /** SMTP options/URL, a built-in transport configuration, or a transport plugin. */
  transport: TransportConfig | Transport | string;
  /** Default message fields, overridden by individual sendMail calls. */
  defaults?: MailDefaults;
}
