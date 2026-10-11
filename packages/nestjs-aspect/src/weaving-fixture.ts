// Test fixture: Nest testing modules that import `AspectModule`, with a
// logger that records what the module logs.

import type { LoggerService, ModuleMetadata } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { AspectModule } from "./aspect.module";
import type { AspectModuleOptions } from "./aspect.module-definition";

type Level = "log" | "error" | "warn" | "debug" | "verbose";

/** Records the messages logged with the context `AspectModule`. */
export class RecordingLogger implements LoggerService {
  readonly entries: { level: Level; message: string }[] = [];

  log(message: unknown, context?: string): void {
    this.record("log", message, context);
  }

  error(message: unknown, context?: string): void {
    this.record("error", message, context);
  }

  warn(message: unknown, context?: string): void {
    this.record("warn", message, context);
  }

  debug(message: unknown, context?: string): void {
    this.record("debug", message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.record("verbose", message, context);
  }

  /** Messages of one level, in logging order. */
  messages(level: Level): string[] {
    return this.entries
      .filter((entry) => entry.level === level)
      .map((entry) => entry.message);
  }

  private record(level: Level, message: unknown, context?: string): void {
    if (context === "AspectModule") {
      this.entries.push({ level, message: String(message) });
    }
  }
}

const opened: { close(): Promise<void> }[] = [];

/**
 * Compiles a testing module that imports `AspectModule.forRoot(options)`
 * next to the given metadata. The module is not initialized.
 */
export async function compileWoven(
  metadata: ModuleMetadata,
  options: AspectModuleOptions = {},
): Promise<{ moduleRef: TestingModule; logger: RecordingLogger }> {
  const logger = new RecordingLogger();
  const moduleRef = await Test.createTestingModule({
    ...metadata,
    imports: [AspectModule.forRoot(options), ...(metadata.imports ?? [])],
  })
    .setLogger(logger)
    .compile();
  opened.push(moduleRef);
  return { moduleRef, logger };
}

/** Compiles and initializes a woven testing module. */
export async function initWoven(
  metadata: ModuleMetadata,
  options: AspectModuleOptions = {},
): Promise<{ moduleRef: TestingModule; logger: RecordingLogger }> {
  const woven = await compileWoven(metadata, options);
  try {
    await woven.moduleRef.init();
  } catch (error) {
    // Nest rejects close() with the error of a failed init().
    opened.splice(opened.indexOf(woven.moduleRef), 1);
    throw error;
  }
  return woven;
}

/**
 * Starts an HTTP application of a module the fixture compiled, on a free
 * port, and returns its base URL. `closeWoven` closes the application.
 */
export async function listenWoven(moduleRef: TestingModule): Promise<string> {
  const app = moduleRef.createNestApplication();
  // Closing the application closes the module and its HTTP server.
  opened.splice(opened.indexOf(moduleRef), 1, app);
  await app.listen(0);
  return (await app.getUrl()).replace("[::1]", "localhost");
}

/** Closes the modules and applications of the fixture; for `afterEach`. */
export async function closeWoven(): Promise<void> {
  await Promise.all(opened.splice(0).map((closable) => closable.close()));
}
