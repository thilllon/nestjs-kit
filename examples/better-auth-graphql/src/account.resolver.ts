import {
  Args,
  Field,
  ID,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  Subscription,
} from "@nestjs/graphql";
import {
  CurrentUser,
  OptionalAuth,
  Public,
  RequireAuth,
  type AuthUser,
} from "nestjs-slightly-better-auth";
import { Note, NotesService } from "./notes.service.js";

@ObjectType()
export class Profile {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  email!: string;

  @Field(() => String)
  name!: string;
}

/** Operations evaluated against the default instance. */
@Resolver()
export class AccountResolver {
  constructor(private readonly notes: NotesService) {}

  @Public()
  @Query(() => String)
  status() {
    return "ok";
  }

  // The global guard already requires a session for operations without an
  // access decorator; @RequireAuth() states that requirement on the field.
  @RequireAuth()
  @Query(() => Profile)
  profile(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email, name: user.name };
  }

  @OptionalAuth()
  @Query(() => String)
  greeting(@CurrentUser() user: AuthUser | null) {
    return user ? `Hello, ${user.name}` : "Hello, guest";
  }

  // Better Auth's origin check applies to mutations over HTTP: a request that
  // carries the session cookie must come from a trusted origin.
  @Mutation(() => Note)
  addNote(
    @Args("text", { type: () => String }) text: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.notes.add(text, user.name);
  }

  // A socket operation authenticates when it starts, with the credentials of
  // its connection. Events that follow reuse that decision.
  @Subscription(() => Note, { resolve: ([note]: [Note]) => note })
  noteAdded() {
    return this.notes.added();
  }
}
