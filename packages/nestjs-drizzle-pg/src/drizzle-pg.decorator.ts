import { Inject } from "@nestjs/common";
import {
  getDrizzlePgToken,
  getPgConnectionToken,
  getDrizzlePgServiceToken,
} from "./drizzle-pg.interface";

export function InjectDrizzlePg(name?: string): ParameterDecorator {
  return Inject(getDrizzlePgToken(name));
}

export function InjectPgConnection(alias?: string): ParameterDecorator {
  return Inject(getPgConnectionToken(alias));
}

export function InjectDrizzlePgService(alias?: string): ParameterDecorator {
  return Inject(getDrizzlePgServiceToken(alias));
}
