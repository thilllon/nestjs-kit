import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import {
  ASPECT_WEAVER,
  ASPECT_WEAVER_GUARD,
  type ASYNC_OPTIONS_TYPE,
  type AspectModuleOptions,
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
} from "./aspect.module-definition";
import { AspectWeaver } from "./weaver";

/**
 * Weaves the aspects and advisors of the application into the classes its
 * container manages.
 *
 * The module is global and is imported once. Its weaver is a factory
 * provider: it runs while the container instantiates providers, after the
 * module scan, so advice is in place before the router binds route handlers
 * and before the first lifecycle hook. `onModuleInit` completes the weaving
 * with the instances that exist by then, validates the configuration and
 * logs the weaving report; `onApplicationShutdown` detaches the application
 * from the woven classes.
 */
@Global()
@Module({
  providers: [
    {
      provide: ASPECT_WEAVER,
      inject: [
        ModulesContainer,
        { token: MODULE_OPTIONS_TOKEN, optional: true },
      ],
      useFactory: (
        container: ModulesContainer,
        options: AspectModuleOptions = {},
      ) => AspectWeaver.weave(container, AspectModule, options),
    },
    {
      // A provider without dependencies of its own: Nest runs its hook even
      // when the options make the weaver and the module class non-singletons.
      provide: ASPECT_WEAVER_GUARD,
      inject: [ModulesContainer],
      useFactory: (container: ModulesContainer): OnModuleInit => ({
        onModuleInit: () =>
          AspectWeaver.assertSingleton(container, AspectModule),
      }),
    },
  ],
})
export class AspectModule
  extends ConfigurableModuleClass
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(@Inject(ASPECT_WEAVER) private readonly weaver: AspectWeaver) {
    super();
  }

  /** Registers the module with the given options; all of them are optional. */
  static override forRoot(options: AspectModuleOptions = {}): DynamicModule {
    return super.forRoot(options);
  }

  /**
   * Registers the module with options that a factory, a class or an existing
   * provider supplies. The weaver waits for the options, still within the
   * instantiation of the container.
   */
  static override forRootAsync(
    options: typeof ASYNC_OPTIONS_TYPE,
  ): DynamicModule {
    return super.forRootAsync(options);
  }

  onModuleInit(): void {
    this.weaver.complete();
  }

  onApplicationShutdown(): void {
    this.weaver.close();
  }
}
