// A CommonJS declaration consumer for `module: node16`. That mode cannot
// require ESM-only packages, which include Nest 12 and Better Auth, so this file
// imports only the package's own `require`-condition declarations.
import { permission } from "@nestjs-kit/better-auth/admin";
import {
  AuthFailures,
  BetterAuthModule,
  type BetterAuthService,
  getBetterAuthServiceToken,
  isAuthFailure,
} from "@nestjs-kit/better-auth";
import { expressPlatform } from "@nestjs-kit/better-auth/express";
import { nestjs } from "@nestjs-kit/better-auth/plugin";

declare const service: BetterAuthService;

const token: string = getBetterAuthServiceToken("admin");
const denied: boolean = isAuthFailure(AuthFailures.unauthenticated());
const plugin: { id: string } = nestjs();
BetterAuthModule.forRoot({
  auth: service.instance,
  platforms: [expressPlatform()],
});
permission({ user: ["ban"] });

// @ts-expect-error Unknown registration options are rejected.
BetterAuthModule.forRoot({ auth: service.instance, unknownOption: true });
// @ts-expect-error Service tokens take an alias string.
getBetterAuthServiceToken(1);

export { denied, plugin, token };
