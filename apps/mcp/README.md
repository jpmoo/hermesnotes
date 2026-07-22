# @hermes/mcp

MCP server exposing Hermes tasks, projects, tags, and saved collections to
Claude (Desktop, Code, claude.ai) — the same 16-tool surface as the Spaztick
MCP server, backed by the Hermes API.

## Auth

Every request must send a Hermes API key (created in the app under
Settings → API tokens):

```
Authorization: Bearer <key>
```

The key is forwarded to the Hermes API for each call, so access maps to the
key's owner and revoking the key in the app revokes MCP access.

## Run (on the server, next to @hermes/server)

```
HERMES_API=http://127.0.0.1:3000/api MCP_PORT=8082 pnpm --filter @hermes/mcp start
```

Env: `HERMES_API` (default `http://127.0.0.1:3000/api`), `MCP_PORT` (8082),
`MCP_HOST` (0.0.0.0). Transport is stateless streamable HTTP at `/mcp`.

## Client config

```json
{
  "mcpServers": {
    "hermes": {
      "url": "http://your-server:8082/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

## Type resolution

Nothing is hardcoded: at startup (per key, cached 60s) the server resolves the
builtin `task` type (status + Available/Due datespan), a type named `project`,
and the task→project link as whatever reference field on the task type points
at the project type. Project archiving uses the project type's status field if
it has an `archived` option, otherwise an `#archived` tag.

## Tools

task_create · task_find · task_info · task_update · delete_task ·
project_create · project_list · project_info · project_archived ·
project_archive · project_unarchive · delete_project · list_lists ·
tag_list · tag_rename · tag_delete

Destructive tools (delete/archive/rename) are two-step: they describe what
will happen and require a second call with `confirm=true`.
