import { Inject, Module } from "@nestjs/common";
import { ConfigurableModuleClass } from "./pg-listen.module-definition";
import { PgListenService } from "./pg-listen.service";

export const PG_LISTEN_SUBSCRIBER = Symbol("PG_LISTEN_SUBSCRIBER");

export function InjectPgListen(): ParameterDecorator {
  return Inject(PG_LISTEN_SUBSCRIBER);
}

@Module({
  providers: [
    PgListenService,
    {
      provide: PG_LISTEN_SUBSCRIBER,
      inject: [PgListenService],
      useFactory: (service: PgListenService) => service.subscriber,
    },
  ],
  exports: [PgListenService, PG_LISTEN_SUBSCRIBER],
})
export class PgListenModule extends ConfigurableModuleClass {}
