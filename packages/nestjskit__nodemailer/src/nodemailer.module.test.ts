import { Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Transport, Transporter } from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { InjectNodemailer } from "./nodemailer.decorator";
import { NodemailerModule } from "./nodemailer.module";
import { NodemailerService } from "./nodemailer.service";

const message = { to: "reader@example.com", subject: "Welcome", text: "Hello" };

describe("Nodemailer integration", () => {
  it("sends through the injected SDK with defaults and per-message overrides", async () => {
    @Injectable()
    class MailConsumer {
      constructor(@InjectNodemailer() readonly transport: Transporter) {}
    }
    const module = await Test.createTestingModule({
      imports: [
        NodemailerModule.register({
          transport: { jsonTransport: true },
          defaults: { from: "default@example.com", subject: "Default subject" },
        }),
      ],
      providers: [MailConsumer],
    }).compile();
    try {
      const sent = await module.get(MailConsumer).transport.sendMail(message);
      const json = JSON.parse(String(sent.message));
      expect(json).toMatchObject({
        from: { address: "default@example.com" },
        subject: "Welcome",
        text: "Hello",
      });
      expect(sent.envelope.to).toEqual(["reader@example.com"]);
      expect(sent.messageId).toEqual(expect.any(String));
      const override = await module
        .get(NodemailerService)
        .sendMail({ ...message, from: "override@example.com" });
      expect(JSON.parse(String(override.message)).from.address).toBe(
        "override@example.com",
      );
    } finally {
      await module.close();
    }
  });

  it("resolves asynchronous imported configuration and isolates transporter defaults", async () => {
    @Module({
      providers: [{ provide: "MAIL_FROM", useValue: "first@example.com" }],
      exports: ["MAIL_FROM"],
    })
    class ConfigurationModule {}
    const first = await Test.createTestingModule({
      imports: [
        NodemailerModule.registerAsync({
          imports: [ConfigurationModule],
          inject: ["MAIL_FROM"],
          useFactory: async (from: string) => ({
            transport: { jsonTransport: true },
            defaults: { from },
          }),
        }),
      ],
    }).compile();
    const second = await Test.createTestingModule({
      imports: [
        NodemailerModule.register({
          transport: { jsonTransport: true },
          defaults: { from: "second@example.com" },
        }),
      ],
    }).compile();
    try {
      const results = await Promise.all([
        first.get(NodemailerService).sendMail(message),
        second.get(NodemailerService).sendMail(message),
      ]);
      expect(
        results.map(
          (result) => JSON.parse(String(result.message)).from.address,
        ),
      ).toEqual(["first@example.com", "second@example.com"]);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("propagates send and verification failures without checking SMTP on startup", async () => {
    const failure = new Error("SMTP unavailable");
    const verify = vi.fn().mockRejectedValue(failure);
    const close = vi.fn();
    const transport: Transport = {
      name: "offline",
      version: "1.0.0",
      send(_mail, callback) {
        callback(failure);
      },
      verify,
      close,
    };
    const module = await Test.createTestingModule({
      imports: [NodemailerModule.register({ transport })],
    }).compile();
    try {
      await module.init();
      expect(verify).not.toHaveBeenCalled();
      const service = module.get(NodemailerService);
      await expect(service.sendMail(message)).rejects.toBe(failure);
      await expect(service.verify()).rejects.toBe(failure);
    } finally {
      await module.close();
    }
    expect(close).toHaveBeenCalledOnce();
    module.get(NodemailerService).onModuleDestroy();
    expect(close).toHaveBeenCalledOnce();
  });

  it("allows cleanup to be retried when a custom transport throws on close", async () => {
    const close = vi.fn().mockImplementationOnce(() => {
      throw new Error("close failed");
    });
    const service = new NodemailerService({
      transport: { name: "offline", version: "1.0.0", send() {}, close },
    });
    expect(() => service.onModuleDestroy()).toThrow("close failed");
    service.onModuleDestroy();
    service.onModuleDestroy();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("reports unsupported verification without opening a connection", async () => {
    const service = new NodemailerService({
      transport: { jsonTransport: true },
    });
    try {
      await expect(service.verify()).resolves.toBe(false);
    } finally {
      service.onModuleDestroy();
    }
  });
});
