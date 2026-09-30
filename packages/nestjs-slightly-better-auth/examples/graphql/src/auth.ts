import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { nestjs } from "nestjs-slightly-better-auth/plugin";

// The default base URL follows PORT, so Better Auth trusts the origin that
// serves both GraphQL over HTTP and graphql-ws.
const baseURL =
  process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
// Without BETTER_AUTH_SECRET, each process signs cookies with a fresh secret.
// The in-memory stores below also reset on restart, so no session survives it.
const secret =
  process.env.BETTER_AUTH_SECRET ?? randomBytes(32).toString("base64url");

// Better Auth's in-memory adapter needs every core table up front.
function inMemoryDatabase() {
  return memoryAdapter({
    user: [],
    session: [],
    account: [],
    verification: [],
  });
}

/**
 * Application users sign up under /api/auth. bearer() accepts the session
 * token that a graphql-ws client sends as `authorization` in its
 * connection_init payload.
 */
export const auth = betterAuth({
  baseURL,
  secret,
  database: inMemoryDatabase(),
  emailAndPassword: { enabled: true },
  // Better Auth otherwise limits request rates only when NODE_ENV=production.
  rateLimit: { enabled: true },
  // Keep nestjs() last so it observes the hooks of every other plugin.
  plugins: [bearer(), nestjs()],
});

/**
 * Operators use a separate Better Auth instance with its own users, mount path
 * and cookie prefix, so neither instance accepts the other's session cookie.
 */
export const adminAuth = betterAuth({
  baseURL,
  basePath: "/api/admin-auth",
  secret,
  database: inMemoryDatabase(),
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true },
  advanced: { cookiePrefix: "admin-auth" },
  plugins: [nestjs()],
});

declare module "nestjs-slightly-better-auth" {
  interface Register {
    auth: typeof auth;
    instances: { admin: typeof adminAuth };
  }
}
