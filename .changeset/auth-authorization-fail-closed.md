---
"nestjs-slightly-better-auth": patch
---

Fail closed on ambiguous authorization state. When two requirements of one handler publish different values for an invocation parameter, such as a default `orgMember()` and an `orgPermission()` for a route organization, `@ActiveOrganizationId()` and `@ActiveMemberRole()` throw the request-time configuration error `AMBIGUOUS_INVOCATION_VALUE` instead of returning whichever policy ran last, and values published inside a denied requirement branch are discarded. Empty `anyOf()` and `allOf()` requirement groups fail planning with `EMPTY_REQUIREMENT_GROUP` instead of allowing every caller. An application whose `init()` is still running when another application binds the same Better Auth instance now fails at bootstrap with `INSTANCE_ALREADY_BOUND` instead of serving without its hooks.
