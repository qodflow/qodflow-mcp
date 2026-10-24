# qodflow-mcp

Model Context Protocol (MCP) server for [QodFlow](https://www.qodflow.com), a kanban board with SLA tracking that people and AI agents share. Lets Claude Code, Claude Desktop, Cursor and other MCP clients create, move, assign and report on jobs through a scoped, revocable Personal Access Token.

## Install

```bash
# Claude Code
claude mcp add qodflow -- npx qodflow-mcp
export QODFLOW_API_TOKEN=qf_live_…
```

Any other MCP client: run `npx qodflow-mcp` as the server command with `QODFLOW_API_TOKEN` in its environment (see below). Full guide: https://www.qodflow.com/docs/mcp

To build from source instead, run `npm install` then `npm run build` inside `mcp-server/`; the binary is `qodflow-mcp`.

## Configure your agent

### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "qodflow": {
      "command": "npx",
      "args": ["qodflow-mcp"],
      "env": {
        "QODFLOW_API_TOKEN": "qf_live_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Cursor / ChatGPT Desktop

Use the same `command + env` shape; consult your client's docs for the exact config path.

## Get a token

1. Sign in to QodFlow.
2. Go to **Settings → API Keys**.
3. Click **New token**, give it a name, pick the minimum scopes you need (`jobs:read` + `stages:read` is enough for the current toolset), and copy the plaintext **once** — it isn't shown again.
4. Paste it as `QODFLOW_API_TOKEN` in your agent config.

For integration testing, toggle **Test mode** at token creation; the prefix becomes `qf_test_` and the token binds to test-mode Stripe products.

## Tools (v0.1)

| Tool                     | Scope required | Plan     | Description |
| ------------------------ | -------------- | -------- | ----------- |
| `list_jobs`              | `jobs:read`    | any      | Most recent jobs, paginated. |
| `list_stages`            | `stages:read`  | any      | Pipeline stages with order, color, SLA. |
| `list_tags`              | `tags:read`    | any      | Tags defined on the workspace. |
| `list_members`           | `members:read` | any      | Team members (id, name, masked email hint, role). |
| `create_job`             | `jobs:write`   | any\*    | Create a job in the first (or given) stage. |
| `update_job`             | `jobs:write`   | any\*    | Update title, description, priority, PO number. |
| `move_job`               | `jobs:write`   | any      | Move a job to another stage. |
| `assign_job`             | `mcp:assign`   | any      | Assign a job to a member (or `null` to unassign). |
| `create_tag`             | `tags:write`   | PREMIUM+ | Create a tag. |
| `update_stage`           | `stages:write` | any\*    | Rename a stage, change SLA/color. |
| `claim_job` / `release_job` | `mcp:claim`  | any    | Atomically claim/release a job (lease-based). |
| `report_progress`        | `mcp:claim`    | any      | Append a progress note to a job's timeline. |
| `request_human_decision` | `mcp:decide`   | any      | Ask a human to pick between options. |
| `resolve_decision`       | `mcp:resolve`  | any      | Resolve an open decision. |
| `attach_evidence`        | `mcp:evidence` | any      | Attach a note (+ optional URL) as evidence. |
| `get_timeline` / `list_decisions` / `list_evidence` | `jobs:read` | any | Read a job's timeline / decisions / evidence. |

\* Subject to plan limits (active-job cap, tags gating). When a call
exceeds a plan gate or quota the tool returns an error whose text includes an
`Upgrade: <url>` hint you can relay to the user.

Destructive verbs (delete_team, mass move, etc.) are **never** exposed via MCP. They live behind the UI confirm-literal guard only.

## Security model

- Token scopes are enforced server-side on every call — this binary cannot grant itself privileges it wasn't issued.
- Audit log is written for every token-authed request and is visible to team owners.
- Killswitch: revoke the token from **Settings → API Keys** to stop the agent immediately.
- Rate limit: 120 requests/minute per token (server-enforced).
- This binary does not persist anything to disk and does not phone home — it only talks to `QODFLOW_API_BASE` (default `https://www.qodflow.com`).

### Token handling on shared workstations

The MCP host (Claude Desktop, Cursor) launches this binary as a child process and passes the token via the `QODFLOW_API_TOKEN` environment variable. On Linux that environment is readable by any other process running as the same user via `/proc/PID/environ`, and similar exposure exists on macOS via `ps -ewww` in some configurations. If you operate on a shared workstation or a machine where other untrusted code runs (CI runners, contractor laptops, etc.):

1. **Prefer a per-user token over a shared one** — issue narrow scopes and rotate every 90 days.
2. **Use the OS keychain** for storage: `security add-generic-password` (macOS), `secret-tool` (GNOME), `wincred` (Windows). Have your host config read from it at launch rather than embedding the literal token.
3. **Future:** v1.1 will accept the token via stdin write at startup instead of `env`, eliminating `/proc/PID/environ` exposure. Track issue [token-via-stdin] for adoption.
4. **Never** commit `claude_desktop_config.json` or equivalent to a repository. It contains your token.

## Environment variables

| Var                 | Required | Default              | Description |
| ------------------- | -------- | -------------------- | ----------- |
| `QODFLOW_API_TOKEN` | yes      | —                    | `qf_live_…` or `qf_test_…` PAT. |
| `QODFLOW_API_BASE`  | no       | `https://www.qodflow.com` | Override for self-hosted or local dev. Must be the **www** host — the apex redirects and Node strips the auth header on the cross-origin hop. |

## Development

```bash
npm run dev   # tsx watch on src/index.ts
```

Roadmap: write tools (create job, move job), then audit-log read, then v1.1 hosted-HTTP transport with OAuth.
