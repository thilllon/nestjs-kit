import { PgListenService } from "./pg-listen.service";

export const PG_LISTEN_SUBSCRIBER = Symbol("PG_LISTEN_SUBSCRIBER");

export function getPgListenSubscriberToken(alias?: string): string | symbol {
  return !alias || alias === "default"
    ? PG_LISTEN_SUBSCRIBER
    : `PG_LISTEN_SUBSCRIBER_${alias}`;
}

export function getPgListenServiceToken(
  alias?: string,
): string | typeof PgListenService {
  return !alias || alias === "default"
    ? PgListenService
    : `PG_LISTEN_SERVICE_${alias}`;
}
