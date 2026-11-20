# GitHub-compatible git forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ibnuyau/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ibnuyau/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in pure TypeScript (Node 22, stdlib only).
No git binary, no outside service, no UI — one process, one in-memory store.

## Surfaces

- **Git smart HTTP** — `/{owner}/{repo}.git`: `git-upload-pack` v2
  (`ls-refs`, `fetch`, shallow + deepen) and v0, `git-receive-pack` v0
  with `report-status`. Packfiles are written and read by hand
  (plain objects, OFS_DELTA and REF_DELTA), so clones, fetches,
  shallow clones, and pushes work against a real git client.
- **REST v3** — `/api/v3`: repositories, branches, commits, contents,
  labels, issues, comments, pull requests (squash merge), user, meta.
- **GraphQL** — `/api/graphql`: viewer, repository, issues and pull
  requests with cursor pagination, `node(id:)`, `__type` introspection,
  and mutations (`createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest`, `addComment`). Batch requests supported.
- **MCP** — `/mcp`: JSON-RPC 2.0 Streamable HTTP, era `2026-07-28`
  (`server/discover`, `initialize`, `tools/list`, `tools/call`) with
  six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.

## Run

```sh
node main.ts
```

The server binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, and exits when `$MAKEFUN_ENV_URL/done`
reports `{"done": true}`. Locally (no env URL) it serves on
`127.0.0.1` until stopped. `MAKEFUN_SHOP_TOKEN` sets the bearer token
for `/api/v3`, `/api/graphql`, and `/mcp`; when unset, any non-empty
Bearer token is accepted (dev convenience).

## Layout

- `main.ts` — lifecycle (bind, register, poll `/done`, exit).
- `app.ts` — HTTP server, routing, auth, request ids.
- `githttp.ts` — smart-HTTP handlers.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL parser + executor.
- `mcp.ts` — MCP handlers.
- `store.ts` — repositories, issues, pull requests, merges, global ids.
- `gitcore.ts` — SHA-1 objects, trees, commits, pkt-lines, packfiles.

## Determinism

Every commit the forge creates uses a fixed author and timestamp, ids
are sequential, and no wall-clock time enters stored state — two runs
on the same instance produce byte-identical state exports.

## License

MIT
