import { SendbirdService } from "./sendbird.service";

export function getSendbirdToken(alias = "default") {
  return !alias || alias === "default" ? SendbirdService : `SENDBIRD_${alias}`;
}
