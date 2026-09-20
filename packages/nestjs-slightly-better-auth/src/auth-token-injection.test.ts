import "reflect-metadata";
import { Inject, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { expect, it } from "vitest";
import {
  getBetterAuthHandleToken,
  getBetterAuthInstanceToken,
  getBetterAuthOptionsToken,
  getBetterAuthServiceToken,
} from "./auth-tokens.js";

it("keeps default and named collaborators isolated through Nest injection and shutdown", async () => {
  const closed: string[] = [];
  const primary = {
    endpoint: "https://primary.example",
    onApplicationShutdown: () => closed.push("primary"),
  };
  const admin = {
    endpoint: "https://admin.example",
    onApplicationShutdown: () => closed.push("admin"),
  };
  const primaryOptions = Object.freeze({ cookiePrefix: "primary" });
  const adminOptions = Object.freeze({ cookiePrefix: "admin" });
  const primaryService = { instance: primary };
  const adminService = { instance: admin };
  const primaryHandle = { name: "default", instance: primary };
  const adminHandle = { name: "admin", instance: admin };
  type PrimaryValue = typeof primary;
  type AdminValue = typeof admin;
  type PrimaryOptionsValue = typeof primaryOptions;
  type AdminOptionsValue = typeof adminOptions;
  type PrimaryServiceValue = typeof primaryService;
  type AdminServiceValue = typeof adminService;
  type PrimaryHandleValue = typeof primaryHandle;
  type AdminHandleValue = typeof adminHandle;
  @Injectable()
  class Consumer {
    constructor(
      @Inject(getBetterAuthInstanceToken()) readonly primary: PrimaryValue,
      @Inject(getBetterAuthInstanceToken("admin")) readonly admin: AdminValue,
      @Inject(getBetterAuthOptionsToken(""))
      readonly primaryOptions: PrimaryOptionsValue,
      @Inject(getBetterAuthOptionsToken("admin"))
      readonly adminOptions: AdminOptionsValue,
      @Inject(getBetterAuthServiceToken())
      readonly primaryService: PrimaryServiceValue,
      @Inject(getBetterAuthServiceToken("admin"))
      readonly adminService: AdminServiceValue,
      @Inject(getBetterAuthHandleToken())
      readonly primaryHandle: PrimaryHandleValue,
      @Inject(getBetterAuthHandleToken("admin"))
      readonly adminHandle: AdminHandleValue,
    ) {}
  }
  const module = await Test.createTestingModule({
    providers: [
      Consumer,
      { provide: getBetterAuthInstanceToken("default"), useValue: primary },
      { provide: getBetterAuthInstanceToken("admin"), useValue: admin },
      {
        provide: getBetterAuthOptionsToken("default"),
        useValue: primaryOptions,
      },
      { provide: getBetterAuthOptionsToken("admin"), useValue: adminOptions },
      {
        provide: getBetterAuthServiceToken("default"),
        useValue: primaryService,
      },
      { provide: getBetterAuthServiceToken("admin"), useValue: adminService },
      { provide: getBetterAuthHandleToken("default"), useValue: primaryHandle },
      { provide: getBetterAuthHandleToken("admin"), useValue: adminHandle },
    ],
  }).compile();
  try {
    await module.init();
    const consumer = module.get(Consumer);
    expect(consumer.primary).toBe(primary);
    expect(consumer.admin).toBe(admin);
    expect(consumer.primaryOptions).toBe(primaryOptions);
    expect(consumer.adminOptions).toBe(adminOptions);
    expect(consumer.primaryService.instance).toBe(primary);
    expect(consumer.adminService.instance).toBe(admin);
    expect(consumer.primaryHandle.instance).toBe(primary);
    expect(consumer.adminHandle.instance).toBe(admin);
  } finally {
    await module.close();
  }
  expect(closed.sort()).toEqual(["admin", "primary"]);
});
