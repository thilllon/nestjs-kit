import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { InjectCloudinary, getCloudinaryToken } from "./cloudinary.tokens";
import { Writable } from "node:stream";
import {
  v2 as cloudinary,
  type UploadStream,
  type UploadApiOptions,
  type UploadResponseCallback,
} from "cloudinary";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudinaryModule } from "./cloudinary.module";
import { CloudinaryService } from "./cloudinary.service";
import type { IFile } from "./cloudinary.interface";

// Narrow the SDK overload to the options + callback form used by the service.
const uploader = cloudinary.uploader as unknown as {
  upload_stream: (
    options: UploadApiOptions,
    callback?: UploadResponseCallback,
  ) => UploadStream;
};

const file = { buffer: Buffer.from("file"), mimetype: "text/plain" } as IFile;
afterEach(() => vi.restoreAllMocks());
describe("Cloudinary service", () => {
  it("does not mutate the shared SDK configuration or ping on startup", async () => {
    const config = vi.spyOn(cloudinary, "config");
    const ping = vi.spyOn(cloudinary.api, "ping");
    const module = await Test.createTestingModule({
      imports: [
        CloudinaryModule.register({ alias: "", cloud_name: "offline" }),
      ],
    }).compile();
    await module.init();
    expect(config).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    await module.close();
  });
  it("awaits an explicitly enabled startup ping", async () => {
    const ping = vi
      .spyOn(cloudinary.api, "ping")
      .mockResolvedValue({ status: "ok" });
    const module = await Test.createTestingModule({
      imports: [
        CloudinaryModule.register({
          alias: "default",
          cloud_name: "offline",
          pingOnInit: true,
        }),
      ],
    }).compile();
    await module.init();
    expect(ping).toHaveBeenCalledWith({ cloud_name: "offline" });
    await module.close();
  });
  it("keeps account configuration separate for each upload", async () => {
    const upload = vi
      .spyOn(uploader, "upload_stream")
      .mockImplementation((_options, callback) => {
        const stream = new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
          final(done) {
            callback?.(undefined, { public_id: "uploaded" } as never);
            done();
          },
        });
        return stream as UploadStream;
      });
    const first = new CloudinaryService({
      cloud_name: "first",
      api_key: "first-key",
    });
    const second = new CloudinaryService({
      cloud_name: "second",
      api_key: "second-key",
    });
    await Promise.all([first.uploadFile(file), second.uploadFile(file)]);
    expect(upload.mock.calls.map(([options]) => options.cloud_name)).toEqual([
      "first",
      "second",
    ]);
  });
  it.each(["image/png", "application/pdf"])(
    "uploads unchanged %s bytes and forwards Cloudinary transformations",
    async (mimetype) => {
      const chunks: Buffer[] = [];
      const options: UploadApiOptions = {
        transformation: [{ width: 1200, crop: "limit" }],
        eager: [{ width: 200, height: 200, crop: "fill" }],
      };
      const upload = vi
        .spyOn(uploader, "upload_stream")
        .mockImplementation((_options, callback) => {
          return new Writable({
            write(chunk: Buffer, _encoding, done) {
              chunks.push(chunk);
              done();
            },
            final(done) {
              callback?.(undefined, { public_id: "uploaded" } as never);
              done();
            },
          }) as UploadStream;
        });
      const result = await new CloudinaryService({
        cloud_name: "account",
      }).uploadFile({ ...file, mimetype }, options);
      expect(Buffer.concat(chunks)).toEqual(file.buffer);
      expect(upload).toHaveBeenCalledWith(
        { cloud_name: "account", ...options },
        expect.any(Function),
      );
      expect(result).toEqual({ public_id: "uploaded" });
    },
  );
  it("rejects SDK upload callback errors", async () => {
    vi.spyOn(uploader, "upload_stream").mockImplementation(
      (_options, callback) => {
        return new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
          final(done) {
            callback?.(
              { message: "upload denied", name: "Error", http_code: 403 },
              undefined,
            );
            done();
          },
        }) as UploadStream;
      },
    );
    await expect(
      new CloudinaryService({}).uploadFile(file),
    ).rejects.toMatchObject({ message: "upload denied", http_code: 403 });
  });
  it("rejects upload stream failures", async () => {
    vi.spyOn(uploader, "upload_stream").mockImplementation(
      () =>
        new Writable({
          write(_chunk, _encoding, done) {
            done(new Error("upload failed"));
          },
        }) as UploadStream,
    );
    await expect(new CloudinaryService({}).uploadFile(file)).rejects.toThrow(
      "upload failed",
    );
  });
  it("rejects an empty SDK callback result", async () => {
    vi.spyOn(uploader, "upload_stream").mockImplementation(
      (_options, callback) => {
        callback?.(undefined, undefined);
        return new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }) as UploadStream;
      },
    );
    await expect(new CloudinaryService({}).uploadFile(file)).rejects.toThrow(
      "no upload result",
    );
  });
  it("signs URLs with the account-specific secret", async () => {
    const sign = vi
      .spyOn(cloudinary.utils, "api_sign_request")
      .mockReturnValue("signature");
    const result = await new CloudinaryService({
      cloud_name: "first",
      api_key: "key",
      api_secret: "secret",
    }).createSignedUploadUrl({ public_id: "asset", resource_type: "image" });
    expect(result.url).toBe(
      "https://api.cloudinary.com/v1_1/first/image/upload",
    );
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({ public_id: "asset" }),
      "secret",
      "sha1",
      2,
    );
  });
});

it.each([false, true])(
  "isolates named accounts through Nest injection (first async=%s)",
  async (firstAsync) => {
    @Injectable()
    class Consumer {
      constructor(
        @InjectCloudinary("first") readonly first: CloudinaryService,
        @InjectCloudinary("second") readonly second: CloudinaryService,
      ) {}
    }
    const register = (alias: string, async: boolean) => {
      const options = {
        cloud_name: alias,
        api_key: `${alias}-key`,
        api_secret: `${alias}-secret`,
        upload_prefix: `https://${alias}.example.com`,
        signature_algorithm: alias === "first" ? "sha1" : "sha256",
      };
      return async
        ? CloudinaryModule.registerAsync({
            alias,
            global: false,
            useFactory: async () => options,
          })
        : CloudinaryModule.register({ ...options, alias, global: false });
    };
    const config = vi.spyOn(cloudinary, "config");
    const ping = vi
      .spyOn(cloudinary.api, "ping")
      .mockResolvedValue({ status: "ok" });
    const upload = vi.spyOn(uploader, "upload_stream").mockImplementation(
      (_options, callback) =>
        new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
          final(done) {
            callback?.(undefined, { public_id: "uploaded" } as never);
            done();
          },
        }) as UploadStream,
    );
    const module = await Test.createTestingModule({
      imports: [register("first", firstAsync), register("second", !firstAsync)],
      providers: [Consumer],
    }).compile();
    await module.init();
    const { first, second } = module.get(Consumer);
    expect(first).not.toBe(second);
    expect(first).toBe(module.get(getCloudinaryToken("first")));
    expect(second).toBe(module.get(getCloudinaryToken("second")));
    await Promise.all([
      first.ping(),
      second.ping(),
      first.uploadFile(file),
      second.uploadFile(file),
    ]);
    for (const calls of [ping.mock.calls, upload.mock.calls]) {
      expect(calls.map(([options]) => options)).toEqual([
        {
          cloud_name: "first",
          api_key: "first-key",
          api_secret: "first-secret",
          upload_prefix: "https://first.example.com",
          signature_algorithm: "sha1",
        },
        {
          cloud_name: "second",
          api_key: "second-key",
          api_secret: "second-secret",
          upload_prefix: "https://second.example.com",
          signature_algorithm: "sha256",
        },
      ]);
    }
    for (const [alias, service] of [
      ["first", first],
      ["second", second],
    ] as const) {
      const signed = await service.createSignedUploadUrl({
        public_id: "asset",
        resource_type: "image",
      });
      expect(signed.signature).toBe(
        createHash(alias === "first" ? "sha1" : "sha256")
          .update(
            `public_id=asset&timestamp=${signed.timestamp}${alias}-secret`,
          )
          .digest("hex"),
      );
      expect(signed.url).toBe(
        `https://${alias}.example.com/v1_1/${alias}/image/upload`,
      );
      expect(signed.api_key).toBe(`${alias}-key`);
    }
    // SDK helpers may read global defaults, but the adapter never writes configuration.
    expect(config.mock.calls.every((args) => typeof args[0] !== "object")).toBe(
      true,
    );
    expect("instance" in first).toBe(false);
    expect("cloudinary" in first).toBe(false);
    await module.close();
  },
);
