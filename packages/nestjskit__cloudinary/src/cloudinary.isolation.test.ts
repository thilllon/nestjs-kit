import { createHash } from "node:crypto";
import https from "node:https";
import { v2 as cloudinary } from "cloudinary";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IFile } from "./cloudinary.interface";
import { CloudinaryService } from "./cloudinary.service";

const credentials = {
  cloud_name: "local",
  api_key: "local-key",
  api_secret: "local-secret",
};
const file = { buffer: Buffer.from("offline") } as IFile;
const signedOptions = { public_id: "asset", resource_type: "image" as const };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cloudinary.config(true);
});

function captureRequests() {
  return vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("offline request boundary");
  });
}

describe("Cloudinary SDK request isolation", () => {
  it("sends real SDK ping/upload requests to each local endpoint without inherited OAuth", async () => {
    const request = captureRequests();
    for (const alias of ["first", "second"]) {
      const service = new CloudinaryService({
        cloud_name: alias,
        api_key: `${alias}-key`,
        api_secret: `${alias}-secret`,
        upload_prefix: `https://${alias}.example.test`,
      });
      await expect(service.ping()).rejects.toThrow("offline request boundary");
      expect(request.mock.lastCall?.[0]).toMatchObject({
        hostname: `${alias}.example.test`,
        auth: `${alias}-key:${alias}-secret`,
      });
      await expect(service.uploadFile(file)).rejects.toThrow(
        "offline request boundary",
      );
      expect(request.mock.lastCall?.[0]).toMatchObject({
        hostname: `${alias}.example.test`,
        path: `/v1_1/${alias}/image/upload`,
      });
      expect(request.mock.lastCall?.[0]).not.toHaveProperty(
        "headers.Authorization",
      );
    }
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("keeps per-upload authentication and routing overrides out of real SDK requests", async () => {
    const request = captureRequests();
    const service = new CloudinaryService(credentials);
    await expect(
      service.uploadFile(file, {
        cloud_name: "other",
        api_key: "other-key",
        api_secret: "other-secret",
        oauth_token: "other-oauth",
        upload_prefix: "https://other.example.test",
        api_proxy: "https://proxy.example.test",
        extra_headers: { Authorization: "Bearer other-header" },
        transformation: [{ width: 100, crop: "limit" }],
      }),
    ).rejects.toThrow("offline request boundary");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.lastCall?.[0]).toMatchObject({
      hostname: "api.cloudinary.com",
      path: "/v1_1/local/image/upload",
    });
    expect(request.mock.lastCall?.[0]).not.toHaveProperty(
      "headers.Authorization",
    );
    expect(request.mock.lastCall?.[0]).not.toHaveProperty("agent");
  });

  it("supports an explicitly local OAuth token for ping and upload", async () => {
    const request = captureRequests();
    const service = new CloudinaryService({
      cloud_name: "local",
      oauth_token: "local-oauth",
    });
    for (const operation of [
      () => service.ping(),
      () => service.uploadFile(file),
    ]) {
      await expect(operation()).rejects.toThrow("offline request boundary");
      expect(request.mock.lastCall?.[0]).toMatchObject({
        hostname: "api.cloudinary.com",
        headers: { Authorization: "Bearer local-oauth" },
      });
    }
    await expect(service.createSignedUploadUrl(signedOptions)).rejects.toThrow(
      "registration-local api_key and api_secret",
    );
  });

  it.each([
    { oauth_token: "ambient-oauth" },
    { upload_prefix: "https://ambient.example.test" },
    { api_proxy: "https://proxy.example.test" },
    { api_secret: "ambient-secret" },
    { signature_algorithm: "sha256" },
    { future_sdk_setting: true },
  ])(
    "rejects SDK configuration introduced after registration: %j",
    async (ambient) => {
      const request = captureRequests();
      const service = new CloudinaryService(credentials);
      cloudinary.config(ambient);
      await expect(service.ping()).rejects.toThrow(
        "empty shared SDK configuration",
      );
      await expect(service.uploadFile(file)).rejects.toThrow(
        "empty shared SDK configuration",
      );
      await expect(
        service.createSignedUploadUrl(signedOptions),
      ).rejects.toThrow("empty shared SDK configuration");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["CLOUDINARY_URL", "CLOUDINARY_ACCOUNT_URL", "CLOUDINARY_API_PROXY"])(
    "rejects %s introduced after SDK initialization",
    async (name) => {
      const request = captureRequests();
      const service = new CloudinaryService(credentials);
      cloudinary.config();
      vi.stubEnv(name, "configured");
      await expect(service.ping()).rejects.toThrow(
        "empty shared SDK configuration",
      );
      await expect(service.uploadFile(file)).rejects.toThrow(
        "empty shared SDK configuration",
      );
      await expect(
        service.createSignedUploadUrl(signedOptions),
      ).rejects.toThrow("empty shared SDK configuration");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { cloud_name: "local" },
    { cloud_name: "local", api_key: "key" },
  ])(
    "rejects missing local credentials before making requests: %j",
    async (options) => {
      const request = captureRequests();
      const service = new CloudinaryService(options);
      await expect(service.ping()).rejects.toThrow("registration-local");
      await expect(service.uploadFile(file)).rejects.toThrow(
        "registration-local",
      );
      await expect(
        service.createSignedUploadUrl(signedOptions),
      ).rejects.toThrow("registration-local");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("allows an explicit direct-signing secret without inheriting SDK credentials", async () => {
    const service = new CloudinaryService({
      cloud_name: "local",
      api_key: "key",
      signature_algorithm: "sha256",
    });
    const signed = await service.createSignedUploadUrl(
      signedOptions,
      "override-secret",
    );
    expect(signed.signature).toBe(
      createHash("sha256")
        .update(`public_id=asset&timestamp=${signed.timestamp}override-secret`)
        .digest("hex"),
    );
  });
});
