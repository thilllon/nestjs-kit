import { Module } from "@nestjs/common";
import { ConfigurableModuleClass } from "./pg-listen.module-definition";

export { InjectPgListen, InjectPgListenService } from "./pg-listen.decorator";
export { PG_LISTEN_SUBSCRIBER } from "./pg-listen.tokens";

@Module({})
export class PgListenModule extends ConfigurableModuleClass {}
