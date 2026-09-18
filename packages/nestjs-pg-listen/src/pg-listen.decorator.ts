import { Inject } from "@nestjs/common";
import {
  getPgListenServiceToken,
  getPgListenSubscriberToken,
} from "./pg-listen.tokens";

export function InjectPgListen(alias?: string): ParameterDecorator {
  return Inject(getPgListenSubscriberToken(alias));
}

export function InjectPgListenService(alias?: string): ParameterDecorator {
  return Inject(getPgListenServiceToken(alias));
}
