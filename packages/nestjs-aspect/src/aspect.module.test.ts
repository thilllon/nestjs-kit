import "reflect-metadata";
import {
  Controller,
  Get,
  Injectable,
  Module,
  type OnModuleInit,
  Scope,
  SetMetadata,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import {
  AfterReturning,
  Aspect,
  AspectModule,
  Before,
  type JoinPoint,
  type AnyShape,
  P,
} from "./index";

const TAG = "aspect-module-test:tag";

/**
 * The application of `docs/spike/weaving-timing.ts`, woven by `AspectModule`.
 * Every call declares its own classes: stubs live on class prototypes, which
 * the tests of one file share.
 */
function createApplication(
  aspectModule: () => unknown = () => AspectModule.forRoot(),
) {
  const log: string[] = [];

  @Injectable()
  class UserService {
    find(id: number) {
      return this.load(id);
    }

    load(id: number) {
      return { id };
    }

    async findAsync() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push("findAsync settles");
      return "async";
    }
  }

  @Injectable({ scope: Scope.REQUEST })
  class ScopedThing {
    hello() {
      return "scoped";
    }
  }

  @Controller()
  class UserController {
    constructor(
      private readonly users: UserService,
      private readonly scoped: ScopedThing,
    ) {}

    @Get("u")
    @SetMetadata(TAG, "kept")
    get() {
      return { user: this.users.find(1), scoped: this.scoped.hello() };
    }
  }

  @Injectable()
  class DeepInit implements OnModuleInit {
    constructor(private readonly users: UserService) {}

    onModuleInit() {
      log.push("deep onModuleInit");
      this.users.load(42);
    }
  }

  const traced = P.within(UserService, ScopedThing, UserController);

  @Aspect()
  class TraceAspect {
    @Before(traced)
    before(jp: JoinPoint<AnyShape>) {
      log.push(
        `before ${jp.signature.targetType.name}.${String(jp.signature.name)}`,
      );
    }

    @AfterReturning(traced)
    afterReturning(jp: JoinPoint<AnyShape>) {
      log.push(
        `afterReturning ${jp.signature.targetType.name}.${String(jp.signature.name)}`,
      );
    }
  }

  @Module({
    providers: [DeepInit, UserService],
  })
  class DeepModule {}

  @Module({
    imports: [DeepModule],
  })
  class MidModule {}

  @Module({
    imports: [aspectModule() as never, MidModule],
    controllers: [UserController],
    providers: [UserService, ScopedThing, TraceAspect],
  })
  class AppModule {}

  return { AppModule, UserService, UserController, log };
}

describe("AspectModule", () => {
  it("weaves before the router and the lifecycle hooks, and stops advising after close", async () => {
    const { AppModule, UserService, UserController, log } = createApplication();
    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    const url = (await app.getUrl()).replace("[::1]", "localhost");

    // The deepest non-global module runs its hook with advice in place.
    expect(log).toEqual([
      "deep onModuleInit",
      "before UserService.load",
      "afterReturning UserService.load",
    ]);

    log.length = 0;
    const body = await (await fetch(`${url}/u`)).json();
    expect(body).toEqual({ user: { id: 1 }, scoped: "scoped" });
    expect(log).toEqual([
      // The route handler the router captured is the stub.
      "before UserController.get",
      "before UserService.find",
      // Self-invocation is advised.
      "before UserService.load",
      "afterReturning UserService.load",
      "afterReturning UserService.find",
      // A request-scoped provider is advised.
      "before ScopedThing.hello",
      "afterReturning ScopedThing.hello",
      "afterReturning UserController.get",
    ]);
    expect(Reflect.getMetadata(TAG, UserController.prototype.get)).toBe("kept");
    expect(Reflect.getMetadata("path", UserController.prototype.get)).toBe("u");

    log.length = 0;
    await expect(app.get(UserService).findAsync()).resolves.toBe("async");
    expect(log).toEqual([
      "before UserService.findAsync",
      "findAsync settles",
      "afterReturning UserService.findAsync",
    ]);

    const service = app.get(UserService);
    await app.close();
    log.length = 0;
    expect(service.find(7)).toEqual({ id: 7 });
    expect(new UserService().find(7)).toEqual({ id: 7 });
    expect(log).toEqual([]);
  });

  it("weaves during compile(), without init()", async () => {
    const { AppModule, UserService, log } = createApplication();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    try {
      expect(moduleRef.get(UserService).load(3)).toEqual({ id: 3 });
      expect(log).toEqual([
        "before UserService.load",
        "afterReturning UserService.load",
      ]);
    } finally {
      await moduleRef.close();
    }
  });

  it("weaves with options resolved by an asynchronous factory", async () => {
    const { AppModule, log } = createApplication(() =>
      AspectModule.forRootAsync({
        useFactory: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { report: false as const };
        },
      }),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    try {
      await moduleRef.init();
      expect(log).toEqual([
        "deep onModuleInit",
        "before UserService.load",
        "afterReturning UserService.load",
      ]);
    } finally {
      await moduleRef.close();
    }
  });
});
