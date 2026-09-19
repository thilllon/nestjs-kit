import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import type { NodemailerModuleOptions } from "./nodemailer.interface";
import { getNodemailerOptionsToken } from "./nodemailer.module-definition";

@Injectable()
export class NodemailerService implements OnModuleDestroy {
  readonly transporter: Transporter;
  private closed = false;

  constructor(
    @Inject(getNodemailerOptionsToken()) options: NodemailerModuleOptions,
  ) {
    this.transporter = createTransport(options.transport, options.defaults);
  }

  onModuleDestroy(): void {
    if (this.closed) {
      return;
    }
    this.transporter.close();
    this.closed = true;
  }
}
