---
"nestjs-slightly-better-auth": patch
---

Expose only the upgrade URL's path, without its query string or fragment, as the request URL of an Apollo graphql-ws operation whose socket is not open when the operation starts. Principal sources receive that URL as `PrincipalRequest.request` and policies as the context's `request`, so a cached GraphQL context of a closed connection no longer hands them the closed connection's query-string credential, such as `?access_token=`. Operations of an open connection keep the full upgrade URL, the origin check still reads the connection's handshake, and Mercurius socket operations are unchanged.
