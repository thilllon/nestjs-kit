import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import type { NodemailerModuleOptions } from "./nodemailer.interface";
import { MODULE_OPTIONS_TOKEN } from "./nodemailer.module-definition";

@Injectable()
export class NodemailerService implements OnModuleDestroy {
  readonly transporter: Transporter;
  private closed = false;

  constructor(@Inject(MODULE_OPTIONS_TOKEN) options: NodemailerModuleOptions) {
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
