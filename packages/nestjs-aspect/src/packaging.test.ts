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
    rejected = error instanceof kit.AopConfigurationError && error instanceof Error;
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

const consumers = {
  esm: `import * as kit from "${packageName}";
${scenario}`,
  cjs: `const kit = require("${packageName}");
${scenario}`,
};

const declarations = `import {
  AopAdvisor,
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

@AopAdvisor()
class TracingAdvisor implements PointcutAdvisor {
  readonly pointcut = retryable.or(rename);
  readonly advice: MethodInterceptor = {
    invoke: (invocation) => invocation.proceed(),
  };
}

void ResilienceAspect;
void TracingAdvisor;
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
          "After",
          "AfterReturning",
          "AfterThrowing",
          "AopAdvisor",
          "AopConfigurationError",
          "AopNotReadyError",
          "AopUsageError",
          "Around",
          "Aspect",
          "Before",
          "P",
          "createAnnotation",
          "isAnnotation",
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

  it("recognizes the errors of one format as instances of the other format's classes", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { createRequire } from "node:module";
import * as esm from "${packageName}";
const cjs = createRequire(import.meta.url)("${packageName}");
class Custom extends esm.AopUsageError {}
console.log(JSON.stringify([
  cjs.AopUsageError !== esm.AopUsageError,
  new cjs.AopUsageError("x") instanceof esm.AopUsageError,
  new esm.AopNotReadyError("x") instanceof cjs.AopNotReadyError,
  new cjs.AopUsageError("x") instanceof esm.AopConfigurationError,
  new cjs.AopUsageError("x") instanceof Custom,
  new Custom("x") instanceof cjs.AopUsageError,
  new Error("x") instanceof esm.AopUsageError,
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
