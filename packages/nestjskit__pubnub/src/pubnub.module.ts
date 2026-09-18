import { Module } from "@nestjs/common";
import { ConfigurableModuleClass } from "./pubnub.module-definition";

@Module({})
export class PubNubModule extends ConfigurableModuleClass {}
