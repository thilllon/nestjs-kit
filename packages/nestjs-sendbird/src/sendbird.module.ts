import { Module } from "@nestjs/common";
import { ConfigurableModuleClass } from "./sendbird.module-definition";

@Module({})
export class SendbirdModule extends ConfigurableModuleClass {}
