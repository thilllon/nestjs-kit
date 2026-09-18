import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import PubNub from "pubnub";
type PubnubConfig = ConstructorParameters<typeof PubNub>[0];
import { getOptionsToken } from "./pubnub.module-definition";

@Injectable()
export class PubNubService extends PubNub implements OnModuleDestroy {
  constructor(@Inject(getOptionsToken()) options: PubnubConfig) {
    super(options);
  }
  onModuleDestroy(): void {
    this.destroy();
  }
}
