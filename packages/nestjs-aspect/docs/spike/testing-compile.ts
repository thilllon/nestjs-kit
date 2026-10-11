import { Global, Injectable, Module } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import "reflect-metadata";

// Question: does TestingModule.compile() alone run the weaver factory,
// or does weaving happen only once init() is called?

let woven = false;

@Injectable()
class Service {
  run() {
    return "ok";
  }
}

@Global()
@Module({
  providers: [
    {
      provide: "AOP_WEAVER",
      inject: [ModulesContainer],
      useFactory: (container: ModulesContainer) => {
        woven = container.size > 0;
        return {};
      },
    },
  ],
})
class AopModule {}

@Module({
  imports: [AopModule],
  providers: [Service],
})
class AppModule {}

const testingModule = await Test.createTestingModule({
  imports: [AppModule],
}).compile();
console.log("woven after compile() without init():", woven);
await testingModule.close();
