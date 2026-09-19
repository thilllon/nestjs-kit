import { PubNubService } from "./pubnub.service";

export function getPubNubClientToken(alias = "default") {
  return !alias || alias === "default" ? PubNubService : `PUBNUB_${alias}`;
}
