import { Inject } from "@nestjs/common";
import { PubNubService } from "./pubnub.service";

export function getPubNubClientToken(alias = "default") {
  if (!alias.trim() || alias !== alias.trim()) {
    throw new Error(
      "PubNub alias must be a non-empty string without surrounding whitespace",
    );
  }
  return alias === "default" ? PubNubService : `PUBNUB_${alias}`;
}

export function InjectPubNubClient(alias?: string): ParameterDecorator {
  return Inject(getPubNubClientToken(alias));
}
