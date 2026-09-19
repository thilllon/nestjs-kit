import { Module } from "@nestjs/common";
import { NODEMAILER_TRANSPORTER } from "./nodemailer.tokens";
import { ConfigurableModuleClass } from "./nodemailer.module-definition";
import { NodemailerService } from "./nodemailer.service";

@Module({
  providers: [
    NodemailerService,
    {
      provide: NODEMAILER_TRANSPORTER,
      inject: [NodemailerService],
      useFactory: (service: NodemailerService) => service.transporter,
    },
  ],
  exports: [NodemailerService, NODEMAILER_TRANSPORTER],
})
export class NodemailerModule extends ConfigurableModuleClass {}
