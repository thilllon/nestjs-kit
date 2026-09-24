import { Module } from "@nestjs/common";
import { ConfigurableModuleClass } from "./sendgrid.module-definition";

@Module({})
export class SendGridModule extends ConfigurableModuleClass {}
