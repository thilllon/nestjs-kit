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
      imports: [CloudinaryModule.register({ cloud_name: "offline" })],
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
        CloudinaryModule.register({ cloud_name: "offline", pingOnInit: true }),
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
  it("rejects image transformation errors instead of leaving a pending promise", async () => {
    const service = new CloudinaryService({});
    await expect(
      service.uploadFile({ ...file, mimetype: "image/png" }, {}, { width: 10 }),
    ).rejects.toThrow();
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
    );
  });
});
