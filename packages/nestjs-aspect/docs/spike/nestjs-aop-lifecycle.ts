import { Injectable, Module, OnModuleInit } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  AopModule,
  Aspect,
  createDecorator,
  LazyDecorator,
  WrapParams,
} from "@toss/nestjs-aop";
import "reflect-metadata";

const log: string[] = [];
const TRACE = Symbol("TRACE");
const Trace = () => createDecorator(TRACE);

@Aspect(TRACE)
class TraceAspect implements LazyDecorator {
  wrap({ method, methodName }: WrapParams) {
    return (...a: any[]) => {
      log.push(`advised ${methodName}`);
      return method(...a);
    };
  }
}

@Injectable()
class Svc {
  @Trace()
  run(from: string) {
    log.push(`run from ${from}`);
  }
}

@Injectable()
class Deep implements OnModuleInit {
  constructor(private s: Svc) {}

  onModuleInit() {
    this.s.run("deep onModuleInit");
  }
}

@Module({
  providers: [Deep, Svc, TraceAspect],
  exports: [Svc],
})
class DeepModule {}

@Module({
  imports: [DeepModule],
})
class Mid {}

@Module({
  imports: [AopModule, Mid],
})
class App {}

const app = await NestFactory.createApplicationContext(App, { logger: false });

await app.init();

app.get(Svc).run("after init");
// Type safety: the decorator accepts any method, and the method passed to wrap is an untyped Function
console.log(log.join("\n"));
await app.close();
