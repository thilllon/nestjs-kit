import { ApolloDriver, type ApolloDriverConfig } from "@nestjs/apollo";
import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";
import { BetterAuthModule } from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { apolloTransport } from "nestjs-slightly-better-auth/graphql";
import { AccountResolver } from "./account.resolver.js";
import { AdminResolver } from "./admin.resolver.js";
import { adminAuth, auth } from "./auth.js";
import { NotesService } from "./notes.service.js";

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      // graphql-ws serves subscriptions and other socket operations on the
      // same /graphql path as HTTP operations.
      subscriptions: { "graphql-ws": true },
      // Field and reference resolvers run the guard only with these enhancers.
      fieldResolverEnhancers: ["guards", "filters"],
    }),
    // The default instance declares the app-wide HTTP platform, which mounts
    // every instance's auth routes, and the Apollo transport, which
    // authenticates GraphQL operations for every instance.
    BetterAuthModule.forRoot({
      auth,
      platforms: [expressPlatform()],
      transports: [apolloTransport()],
    }),
    // A named instance gets its own injection tokens, mount and cookies.
    BetterAuthModule.forRoot({ name: "admin", auth: adminAuth }),
  ],
  providers: [NotesService, AccountResolver, AdminResolver],
})
export class AppModule {}
