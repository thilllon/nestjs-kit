import {
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  OnModuleInit,
  Scope,
  SetMetadata,
} from "@nestjs/common";
import { ModulesContainer, NestFactory } from "@nestjs/core";
import "reflect-metadata";

const log: string[] = [];
const ORIGINAL = Symbol("original");
const TAG = "spike:tag";

// --- minimal weaver: runs during the instantiation phase, before registerRouter and the lifecycle hooks
const contexts = new Set<object>();
function weave(container: ModulesContainer, ctx: object) {
  contexts.add(ctx);
  for (const mod of container.values()) {
    for (const wrapper of [
      ...mod.providers.values(),
      ...mod.controllers.values(),
    ]) {
      const type = wrapper.metatype as any;
      if (!type?.prototype || !/Service|Controller|Scoped/.test(type.name)) {
        continue;
      }
      for (const key of Object.getOwnPropertyNames(type.prototype)) {
        const d = Object.getOwnPropertyDescriptor(type.prototype, key)!;
        if (
          key === "constructor" ||
          typeof d.value !== "function" ||
          d.value[ORIGINAL] ||
          key === "onModuleInit"
        ) {
          continue;
        }
        const original = d.value;
        const stub = function (this: any, ...args: unknown[]) {
          if (contexts.size === 0) {
            return original.apply(this, args); // unmanaged or closed app
          }
          log.push(`before ${type.name}.${key}`);
          const r = original.apply(this, args);
          if (r && typeof r.then === "function") {
            return r.then((v: unknown) => {
              log.push(`afterReturning ${type.name}.${key}`);
              return v;
            });
          }
          log.push(`afterReturning ${type.name}.${key}`);
          return r;
        };
        Object.defineProperty(stub, "name", { value: original.name });
        Object.setPrototypeOf(stub, original); // reflect-metadata lookups walk the [[Prototype]] chain
        (stub as any)[ORIGINAL] = original;
        Object.defineProperty(type.prototype, key, { ...d, value: stub });
      }
    }
  }
}

@Injectable()
class UserService {
  find(id: number) {
    return this.load(id);
  } // self-invocation

  load(id: number) {
    return { id };
  }

  async findAsync() {
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
    private users: UserService,
    private scoped: ScopedThing,
  ) {}

  @Get("u")
  @SetMetadata(TAG, "kept")
  get() {
    return { user: this.users.find(1), scoped: this.scoped.hello() };
  }
}

@Injectable()
class DeepInit implements OnModuleInit {
  constructor(private users: UserService) {}

  onModuleInit() {
    log.push("deep onModuleInit");
    this.users.load(42);
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

@Global()
@Module({
  providers: [
    {
      provide: "AOP_WEAVER",
      inject: [ModulesContainer],
      useFactory: (c: ModulesContainer) => {
        const ctx = {};
        weave(c, ctx);
        log.push("woven");
        return ctx;
      },
    },
  ],
  exports: ["AOP_WEAVER"],
})
class AopModule {}

@Module({
  imports: [AopModule, MidModule],
  controllers: [UserController],
  providers: [UserService, ScopedThing],
})
class AppModule {}

const app = await NestFactory.create(AppModule, { logger: false });
await app.listen(0);
const url = await app.getUrl();
const body = await (
  await fetch(`${url.replace("[::1]", "localhost")}/u`)
).json();
await app.get(UserService).findAsync();
const meta = Reflect.getMetadata(TAG, UserController.prototype.get);
await app.close();
contexts.clear();
log.push("--- after close");
new UserService().find(7);
console.log(JSON.stringify({ body, meta }, null, 0));
console.log(log.join("\n"));
