import {
  Injectable,
  Logger,
  type LoggerService,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import createSubscriber, { type Subscriber } from "pg-listen";
import type { PgListenModuleOptions } from "./pg-listen.module-definition";

@Injectable()
export class PgListenService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  readonly subscriber: Subscriber;
  private readonly logger: LoggerService;
  private closePromise?: Promise<void>;

  constructor(private readonly config: PgListenModuleOptions) {
    this.logger = config.logger ?? new Logger(PgListenService.name);
    this.subscriber = createSubscriber(config.connection, config.options);
    this.subscriber.events.on("error", (error) =>
      this.logger.error(error.message, error.stack),
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.subscriber.connect();
      for (const channel of new Set(this.config.channels)) {
        await this.subscriber.listenTo(channel);
      }
    } catch (error) {
      try {
        await this.onModuleDestroy();
      } catch (closeError) {
        this.logger.error(
          "Failed to close PostgreSQL subscriber after startup failure",
          closeError,
        );
      }
      throw error;
    }
  }

  onModuleDestroy(): Promise<void> {
    this.closePromise ??= Promise.resolve()
      .then(() => this.subscriber.close())
      .catch((error: unknown) => {
        this.closePromise = undefined;
        throw error;
      });
    return this.closePromise;
  }
}
