import { Inject } from "@nestjs/common";
import {
  Field,
  GraphQLISODateTime,
  ID,
  ObjectType,
  Query,
  Resolver,
} from "@nestjs/graphql";
import {
  BetterAuthService,
  CurrentUser,
  UseAuthInstance,
  getBetterAuthServiceToken,
  type AuthOf,
  type AuthUser,
} from "nestjs-slightly-better-auth";

@ObjectType()
export class Operator {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  email!: string;
}

/** Operations evaluated against the named "admin" instance. */
@UseAuthInstance("admin")
@Resolver()
export class AdminResolver {
  constructor(
    @Inject(getBetterAuthServiceToken("admin"))
    private readonly adminAuth: BetterAuthService<AuthOf<"admin">>,
  ) {}

  @Query(() => Operator)
  operator(@CurrentUser() operator: AuthUser<"admin">) {
    return { id: operator.id, email: operator.email };
  }

  @Query(() => GraphQLISODateTime, { nullable: true })
  async operatorSessionExpiresAt() {
    // The named service reads the session the guard resolved for this field.
    const session = await this.adminAuth.getSession();
    return session?.session.expiresAt;
  }
}
