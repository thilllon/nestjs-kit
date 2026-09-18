import { Inject } from "@nestjs/common";
import { getDrizzlePgToken } from "./drizzle-pg.interface";

export function InjectDrizzlePg(name?: string): ParameterDecorator {
  return Inject(getDrizzlePgToken(name));
}
