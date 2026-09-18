import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import PubNub from "pubnub";
type PubnubConfig = ConstructorParameters<typeof PubNub>[0];

@Injectable()
export class PubNubService extends PubNub implements OnModuleDestroy {
  constructor(options: PubnubConfig) {
    super(options);
  }
  onModuleDestroy(): void {
    this.destroy();
  }
}
