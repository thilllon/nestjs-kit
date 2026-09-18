import { Module } from "@nestjs/common";
import { ConfigurableModuleClass } from "./pubnub.module-definition";
import { PubNubService } from "./pubnub.service";

@Module({
  providers: [PubNubService],
  exports: [PubNubService],
})
export class PubNubModule extends ConfigurableModuleClass {}
