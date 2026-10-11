import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = join(__dirname, "..");
const packageName = "nestjs-aspect";
const compiler = join(
  dirname(createRequire(__filename).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

/** Runs inside the package root so its name resolves through `exports`. */
const scenario = `
  const Retryable = kit.createAnnotation("Retryable", { requiresAdvice: true });
  class UserService {
    async findById(id) { return id; }
    rename(name) { return name; }
  }
  const describe = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name);
  Retryable({ attempts: 3 })(UserService.prototype, "findById", describe(UserService, "findById"));

  const retryable = kit.P.annotated(Retryable).and(kit.P.within(UserService));
  class ResilienceAspect {
    retry(jp) { return jp.proceed(); }
  }
  kit.Around(retryable)(ResilienceAspect.prototype, "retry", describe(ResilienceAspect, "retry"));
  kit.Aspect({ order: 10 })(ResilienceAspect);

  const classRef = { type: UserService, beans: [], reachesModule: () => false };
  const matches = (name) => {
    const method = {
      declaringType: UserService,
      targetType: UserService,
      classRef,
      name,
      kind: "method",
      original: UserService.prototype[name],
      isAsync: name === "findById",
    };
    return retryable.classFilter.matches(classRef) && retryable.methodMatcher.matches(method);
  };
  let rejected;
  try {
    kit.Before(undefined);
  } catch (error) {
    rejected = error instanceof kit.AspectConfigurationError && error instanceof Error;
  }
  console.log(JSON.stringify({
    exports: Object.keys(kit).sort(),
    matches: [matches("findById"), matches("rename")],
    guarantees: [...retryable.guarantees],
    requiresAdvice: Retryable.requiresAdvice,
    injectable: Reflect.getMetadata("__injectable__", ResilienceAspect),
    rejected,
  }));
`;

/**
 * A Nest application woven by \`AspectModule\` of \`kit\`. The aspect is
 * declared with the decorators of \`decorators\`, which is another copy of the
 * package in the cross-format test.
 */
const application = `
  const describe = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name);
  class Greeter {
    greet(name) { return this.format(name); }
    format(name) { return "hello " + name; }
  }
  common.Injectable()(Greeter);
  async function bootstrap(kit, decorators, label, log) {
    class TraceAspect {
      before(jp) { log.push(label + " " + jp.toString()); }
    }
    decorators.Before(decorators.P.within(Greeter))(TraceAspect.prototype, "before", describe(TraceAspect, "before"));
    decorators.Aspect()(TraceAspect);
    class AppModule {}
    common.Module({
      imports: [kit.AspectModule.forRoot({ report: false })],
      providers: [Greeter, TraceAspect],
    })(AppModule);
    return core.NestFactory.createApplicationContext(AppModule, { logger: false });
  }
`;

const applications = {
  esm: `import * as common from "@nestjs/common";
import * as core from "@nestjs/core";
import * as kit from "${packageName}";
${application}
const log = [];
const app = await bootstrap(kit, kit, "esm", log);
const greeting = app.get(Greeter).greet("a");
await app.close();
app.get(Greeter).greet("b");
console.log(JSON.stringify({ greeting, log }));`,
  cjs: `const common = require("@nestjs/common");
const core = require("@nestjs/core");
const kit = require("${packageName}");
${application}
(async () => {
  const log = [];
  const app = await bootstrap(kit, kit, "cjs", log);
  const greeting = app.get(Greeter).greet("a");
  await app.close();
  app.get(Greeter).greet("b");
  console.log(JSON.stringify({ greeting, log }));
})();`,
};

const consumers = {
  esm: `import * as kit from "${packageName}";
${scenario}`,
  cjs: `const kit = require("${packageName}");
${scenario}`,
};

const declarations = `import {
  Advisor,
  AspectModule,
  type AspectModuleOptions,
  Around,
  Aspect,
  Before,
  createAnnotation,
  P,
  type JP,
  type MethodInterceptor,
  type PJP,
  type PointcutAdvisor,
} from "${packageName}";
// @ts-expect-error The metadata keys stay internal.
import { ASPECT_METADATA } from "${packageName}";

const Retryable = createAnnotation<
  "Retryable",
  { attempts: number },
  (...args: any[]) => Promise<unknown>
>("Retryable");

class UserService {
  @Retryable({ attempts: 3 })
  async findById(id: number): Promise<string> {
    return String(id);
  }

  // @ts-expect-error Retryable requires a method that returns a Promise.
  @Retryable({ attempts: 3 })
  rename(name: string): string {
    return name;
  }
}

const retryable = P.annotated(Retryable);
const rename = P.method(UserService, "rename");

@Aspect({ order: 10 })
class ResilienceAspect {
  @Around(retryable)
  async retry(jp: PJP<typeof retryable>): Promise<unknown> {
    const attempts: number = jp.annotation(Retryable).attempts;
    void attempts;
    return jp.proceed();
  }

  @Around(rename)
  upperCase(jp: PJP<typeof rename>): string {
    const [name] = jp.args;
    return jp.proceedWith(name.toUpperCase());
  }

  // @ts-expect-error Asynchronous advice is rejected on a synchronous join point.
  @Before(rename)
  async check(jp: JP<typeof rename>): Promise<void> {
    void jp;
  }
}

@Advisor()
class TracingAdvisor {
  static readonly pointcut = retryable.or(rename);

  readonly advice: MethodInterceptor = {
    invoke: (invocation) => invocation.proceed(),
  };
}

// @ts-expect-error The pointcut of an advisor is a static member.
@Advisor()
class InstanceAdvisor implements PointcutAdvisor {
  readonly pointcut = retryable;
  readonly advice: MethodInterceptor = {
    invoke: (invocation) => invocation.proceed(),
  };
}

const options: AspectModuleOptions = { report: false, exclude: [UserService] };
const modules: ReturnType<typeof AspectModule.forRoot>[] = [
  AspectModule.forRoot(),
  AspectModule.forRoot(options),
  AspectModule.forRootAsync({ useFactory: async () => options }),
];

void ResilienceAspect;
void TracingAdvisor;
void InstanceAdvisor;
void modules;
`;

describe("built nestjs-aspect package", () => {
  it.each(["esm", "cjs"] as const)(
    "declares an annotation, a pointcut and an aspect from the actual %s artifact",
    (format) => {
      const output = execFileSync(
        process.execPath,
        [
          ...(format === "esm" ? ["--input-type=module"] : []),
          "--eval",
          consumers[format],
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        exports: [
          "Advisor",
          "After",
          "AfterReturning",
          "AfterThrowing",
          "Around",
          "Aspect",
          "AspectConfigurationError",
          "AspectInspector",
          "AspectModule",
          "AspectNotReadyError",
          "AspectUsageError",
          "Before",
          "DeclareParents",
          "P",
          "createAnnotation",
          "introduced",
          "isAnnotation",
          "isIntroduced",
          "promiseAdapter",
        ],
        matches: [true, false],
        guarantees: ["Retryable"],
        requiresAdvice: true,
        injectable: true,
        rejected: true,
      });
    },
  );

  it.each(["esm", "cjs"] as const)(
    "weaves a Nest application with the actual %s artifact",
    (format) => {
      const output = execFileSync(
        process.execPath,
        [
          ...(format === "esm" ? ["--input-type=module"] : []),
          "--eval",
          applications[format],
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        greeting: "hello a",
        log: [`${format} Greeter.greet("a")`, `${format} Greeter.format("a")`],
      });
    },
  );

  it("keeps two applications apart when one uses each format on the same class", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { createRequire } from "node:module";
import * as common from "@nestjs/common";
import * as core from "@nestjs/core";
import * as esm from "${packageName}";
const cjs = createRequire(import.meta.url)("${packageName}");
${application}
const log = [];
// The aspect of each application is declared with the other format's decorators.
const first = await bootstrap(cjs, esm, "cjs", log);
const stub = Greeter.prototype.greet;
const second = await bootstrap(esm, cjs, "esm", log);
first.get(Greeter).format("a");
second.get(Greeter).format("b");
await first.close();
first.get(Greeter).format("c");
second.get(Greeter).format("d");
await second.close();
console.log(JSON.stringify({ sameStub: Greeter.prototype.greet === stub, log }));`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({
      sameStub: true,
      log: [
        'cjs Greeter.format("a")',
        'esm Greeter.format("b")',
        'esm Greeter.format("d")',
      ],
    });
  });

  it("rejects one application that registers the module of both formats", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { createRequire } from "node:module";
import * as common from "@nestjs/common";
import * as core from "@nestjs/core";
import * as esm from "${packageName}";
const cjs = createRequire(import.meta.url)("${packageName}");
class LibraryModule {}
common.Module({ imports: [esm.AspectModule.forRoot({ strict: false })] })(LibraryModule);
class AppModule {}
common.Module({ imports: [cjs.AspectModule.forRoot(), LibraryModule] })(AppModule);
const error = await core.NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false }).then(() => undefined, (error) => error);
console.log(JSON.stringify([error instanceof esm.AspectConfigurationError, String(error?.message)]));`,
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual([
      true,
      expect.stringContaining(
        "Two copies of AspectModule are registered in one application",
      ),
    ]);
  });

  it("recognizes the errors of one format as instances of the other format's classes", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { createRequire } from "node:module";
import * as esm from "${packageName}";
const cjs = createRequire(import.meta.url)("${packageName}");
class Custom extends esm.AspectUsageError {}
console.log(JSON.stringify([
  cjs.AspectUsageError !== esm.AspectUsageError,
  new cjs.AspectUsageError("x") instanceof esm.AspectUsageError,
  new esm.AspectNotReadyError("x") instanceof cjs.AspectNotReadyError,
  new cjs.AspectUsageError("x") instanceof esm.AspectConfigurationError,
  new cjs.AspectUsageError("x") instanceof Custom,
  new Custom("x") instanceof cjs.AspectUsageError,
  new Error("x") instanceof esm.AspectUsageError,
]));`,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(JSON.parse(output)).toEqual([
      true,
      true,
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  it.each(["cts", "mts"] as const)(
    "type-checks a NodeNext .%s consumer against the built declarations",
    async (extension) => {
      const directory = await mkdtemp(
        join(tmpdir(), `nestjs-aspect-consumer-${extension}-`),
      );
      const modules = join(directory, "node_modules");
      try {
        await mkdir(modules, { recursive: true });
        await Promise.all([
          symlink(root, join(modules, packageName), "dir"),
          symlink(
            join(root, "node_modules/@types"),
            join(modules, "@types"),
            "dir",
          ),
        ]);
        await writeFile(join(directory, `consumer.${extension}`), declarations);
        await writeFile(
          join(directory, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              experimentalDecorators: true,
              emitDecoratorMetadata: true,
              types: ["node"],
            },
            files: [`consumer.${extension}`],
          }),
        );
        const result = await execute(process.execPath, [
          compiler,
          "--project",
          join(directory, "tsconfig.json"),
          "--pretty",
          "false",
        ]).catch((error: { stdout?: string }) => {
          throw new Error(String(error.stdout), { cause: error });
        });
        expect(result).toEqual({ stdout: "", stderr: "" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
