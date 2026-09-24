import { SendGridService } from "./sendgrid.service";

export function getSendGridToken(alias = "default") {
  return !alias || alias === "default" ? SendGridService : `SENDGRID_${alias}`;
}
