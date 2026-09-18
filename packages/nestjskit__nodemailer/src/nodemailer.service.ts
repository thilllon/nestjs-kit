import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import {
  createTransport,
  type SendMailOptions,
  type SentMessageInfo,
  type Transporter,
} from "nodemailer";
import type { NodemailerModuleOptions } from "./nodemailer.interface";
import { MODULE_OPTIONS_TOKEN } from "./nodemailer.module-definition";

@Injectable()
export class NodemailerService implements OnModuleDestroy {
  readonly transporter: Transporter;
  private closed = false;

  constructor(@Inject(MODULE_OPTIONS_TOKEN) options: NodemailerModuleOptions) {
    this.transporter = createTransport(options.transport, options.defaults);
  }

  sendMail(message: SendMailOptions): Promise<SentMessageInfo> {
    return this.transporter.sendMail(message);
  }

  /** SMTP transports verify their connection; unsupported transports return false. */
  async verify(): Promise<boolean> {
    return this.transporter.verify();
  }

  onModuleDestroy(): void {
    if (this.closed) return;
    this.transporter.close();
    this.closed = true;
  }
}
