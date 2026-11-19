# github-core-clone-01 — a GitHub-compatible git forge

A standalone forge in one process, its own in-memory store, no UI, no
outside service. It serves all four surfaces the contest grades:

- **git smart HTTP** (`/<owner>/<repo>.git/...`): upload-pack protocol v2
  and receive-pack v0, with a from-scratch SHA-1 object store, pack
  read/write (plain + OFS/REF deltas), shallow clones and deepening.
- **REST v3** (`/api/v3/...`): repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash merges.
- **GraphQL v4** (`/api/graphql`): viewer, repository, issues, pull
  requests, node ids, mutations and `__type` introspection, over the same
  store the REST surface reads.
- **MCP** (`/mcp`): the 2026-07-28 era (`server/discover`, no handshake)
  plus the legacy `initialize` handshake; tools for repos, issues and
  pull requests.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is
nothing to install: standard library only, no git binary, no network.

`main.ts` binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL`,
polls `/done` and exits 0. The server answers `GET /healthz` with
`{"ok":true}` and a JSON 404 for anything it does not serve.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, wait, exit).
- `src/app.ts` — the HTTP server and surface routing.
- `src/store.ts` — the in-memory store: repos, refs, objects, issues,
  pull requests, labels, comments, plus the merge logic all three API
  surfaces share. Timestamps come from a logical clock, never the wall
  clock, so two runs on the same instance leave the same state.
- `src/gitcore.ts` — pkt-lines, SHA-1 objects, trees, commits, packs.
- `src/githttp.ts` — the smart-HTTP protocol (v2 + v0).
- `src/rest.ts` — REST v3.
- `src/graphql.ts` — GraphQL v4 (hand-written parser + executor).
- `src/mcp.ts` — MCP over streamable HTTP.
- `src/httpkit.ts` — shared HTTP helpers (JSON replies, auth, bodies).
- `src/scenario.ts` — the seeded scenario identities the suite drives.

## Score (local practice suite, 2026-11-19)

120/120 checks pass — feature 600, agent 200, perf 159 — **959/1000**.

MIT licensed.
