import { Inject } from "@nestjs/common";

export const NODEMAILER_TRANSPORTER = Symbol("NODEMAILER_TRANSPORTER");

export function InjectNodemailer(): ParameterDecorator {
  return Inject(NODEMAILER_TRANSPORTER);
}
