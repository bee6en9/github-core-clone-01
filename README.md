# github-core-clone-01 entry

A GitHub-compatible git forge in one process: git smart HTTP, REST v3, GraphQL v4 and MCP, served from its own in-memory store. Node 22 TypeScript, standard library only — no git binary, no package manager, no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set, the entry binds an ephemeral port, registers it with the env and waits for done (the trial lifecycle). Without it, the entry serves standalone on an ephemeral port and prints the port — the mode the local conformance runner (`sdk/run.ts`) dials.

## Layout

- `main.ts` — the entry <-> env lifecycle (register + wait for done) and standalone mode.
- `app.ts` — the HTTP server: routing, JSON plumbing, auth (one bearer token = the scenario viewer), `X-GitHub-Request-Id` on every response, and the route set.
- `scenario.ts` — the seeded scenario RNG ported from the kit (SCENARIO_SEED, fnv1a64, mix64, xorshift64*): the viewer/teammate/stranger/org logins are derived at boot, never guessed.
- `store.ts` — the in-memory store (repos, issues, pulls, users, orgs) with a deterministic logical clock.

## Milestones

- M1 scaffold: lifecycle + app skeleton + store; healthz, API root, 404, request-id; minimal repos create/get/list.
- M2 git: object store + packfile + smart HTTP.
- M3 REST v3: repos/issues/pulls/contents.
- M4 GraphQL v4 (+ introspection).
- M5 MCP endpoint.
- M6 determinism + perf tuning.
- M7 full practice trials, fix, polish.

Built for the make.fun bounty `github-core-clone-01` as @bee6en9. Referral code: vfk2n47z.
