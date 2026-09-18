import { Inject } from "@nestjs/common";
import { PubNubService } from "./pubnub.service";

export function getPubNubClientToken(alias = "default") {
  return !alias || alias === "default" ? PubNubService : `PUBNUB_${alias}`;
}

export function InjectPubNubClient(alias?: string): ParameterDecorator {
  return Inject(getPubNubClientToken(alias));
}
