#!/usr/bin/env node
// QodFlow MCP server — stdio transport, v1.
//
// Wires AI agents (Claude Desktop, Cursor, ChatGPT Desktop) to the QodFlow
// public REST API via a Personal Access Token. The token determines which
// team the agent operates against and which scopes it has — there is no
// separate auth between the agent and this server.
//
// Tools intentionally start with the SHIP-tier subset from
// docs/handoff/shippable-scope-and-toolchain.md §2 — read-only and low-blast
// mutations. Destructive verbs (delete_team etc.) are NEVER exposed here.
// They live behind the UI confirm-literal guard only.
//
// Run:
//   QODFLOW_API_TOKEN=qf_live_xxxx qodflow-mcp
//
// Claude Desktop config example:
//   {
//     "mcpServers": {
//       "qodflow": {
//         "command": "qodflow-mcp",
//         "env": { "QODFLOW_API_TOKEN": "qf_live_..." }
//       }
//     }
//   }

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const TOKEN = process.env.QODFLOW_API_TOKEN;
// MUST be the www host: the apex (qodflow.com) 307-redirects to www, and Node's
// fetch strips the Authorization header on a cross-origin redirect, so every
// call would 401. Point straight at www to keep the Bearer token attached.
const API_BASE = process.env.QODFLOW_API_BASE ?? "https://www.qodflow.com";

if (!TOKEN) {
  console.error("QODFLOW_API_TOKEN env var is required");
  process.exit(1);
}
if (!/^qf_(live|test)_[a-z0-9]{8}_[a-z0-9]{24}$/.test(TOKEN)) {
  console.error("QODFLOW_API_TOKEN format invalid (expected qf_live_xxxx_xxxxxxxx…)");
  process.exit(1);
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "qodflow-mcp/0.1.3",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response from ${path}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = (json as any)?.error;
    const msg = e?.message ?? `HTTP ${res.status}`;
    // Surface the upgrade URL so the agent can relay an actionable upsell to the
    // human (the alert-that-explains), not just a bare error.
    const url = e?.details?.upgradeUrl;
    throw new Error(url ? `${msg} Upgrade: ${url}` : msg);
  }
  return json;
}

// ---- Tool schemas ----

const ListJobsArgs = z.object({
  limit: z.number().int().min(1).max(100).default(25).optional(),
  cursor: z.string().optional(),
});

const GetStagesArgs = z.object({});

const CreateJobArgs = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  stageId: z.string().optional(),
  priority: z.enum(["NORMAL", "FLAGGED", "URGENT"]).optional(),
});

const UpdateJobArgs = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  priority: z.enum(["NORMAL", "FLAGGED", "URGENT"]).optional(),
  poNumber: z.string().optional(),
});

const ListTagsArgs = z.object({});
const ListMembersArgs = z.object({});
const CreateTagArgs = z.object({ name: z.string().min(1).max(40), color: z.string().optional() });
const UpdateStageArgs = z.object({
  id: z.string(),
  name: z.string().min(1).max(60).optional(),
  slaDays: z.number().int().min(1).max(365).optional(),
  color: z.string().optional(),
});

const AssignJobArgs = z.object({
  jobId: z.string(),
  assignedToId: z.string().min(1).nullable(),
});
const MoveJobArgs = z.object({
  jobId: z.string(),
  stageId: z.string(),
  reason: z.string().max(280).optional(),
});

// MCP agent-collaboration primitives (Phase 1-3 of docs/planning/MCP-PLAN.md).
const ClaimJobArgs = z.object({
  jobId: z.string(),
  leaseMinutes: z.number().int().min(1).max(240).optional(),
  note: z.string().max(280).optional(),
});
const ReleaseJobArgs = z.object({
  jobId: z.string(),
  note: z.string().max(280).optional(),
});
const ReportProgressArgs = z.object({
  jobId: z.string(),
  note: z.string().min(1).max(280),
});
const RequestHumanDecisionArgs = z.object({
  jobId: z.string(),
  question: z.string().min(1).max(280),
  options: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(80) })).min(2).max(6),
  ttlDays: z.number().int().min(1).max(30).optional(),
});
const AttachEvidenceArgs = z.object({
  jobId: z.string(),
  note: z.string().min(1).max(280),
  url: z.string().url().max(2048).optional(),
});
const GetTimelineArgs = z.object({
  jobId: z.string(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
const ListDecisionsArgs = z.object({ jobId: z.string() });
const ListEvidenceArgs = z.object({ jobId: z.string() });
const ResolveDecisionArgs = z.object({
  decisionId: z.string(),
  chosenOption: z.string().min(1).max(40),
  humanResponseExcerpt: z.string().min(1).max(280),
});

// Server setup
const server = new Server(
  { name: "qodflow", version: "0.1.3" },
  { capabilities: { tools: {} } },
);

// Tool annotations per MCP spec (2025-06-18) — clients use these to decide
// whether to prompt the user before calling. We pin them static here so a
// hijacked server cannot rug-pull descriptions (Invariant Labs Apr 2025).
//
// Annotation legend:
//   readOnlyHint    — tool only reads data, no state change
//   destructiveHint — tool may make irreversible changes (none in our surface)
//   idempotentHint  — repeated calls with same args = same effect (use with Idempotency-Key)
//   openWorldHint   — tool reaches external systems (everything here hits qodflow.com only)
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_NONDESTR = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "list_jobs",
    description:
      "List jobs in the QodFlow workspace bound to this token. Returns the most recent first. Cursor-paginated.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        cursor: { type: "string", description: "Pagination cursor from a previous response." },
      },
    },
  },
  {
    name: "list_stages",
    description:
      "List pipeline stages for the workspace. Each stage has an order, name, color, and SLA in days. Use stage IDs when referencing positions.",
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_job",
    description:
      "Create a new job in the workspace. Placed in the first stage unless stageId is provided. Requires the jobs:write scope on the token.",
    annotations: WRITE_NONDESTR,    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", maxLength: 5000 },
        stageId: { type: "string" },
        priority: { type: "string", enum: ["NORMAL", "FLAGGED", "URGENT"] },
      },
    },
  },
  {
    name: "update_job",
    description:
      "Update a job's title, description, priority, or PO number. To move a job between stages use move_job; to assign it use assign_job. Completed jobs are read-only: move_job it to an earlier stage first (the server returns 409 JOB_COMPLETED otherwise). Requires jobs:write.",
    annotations: WRITE_IDEMPOTENT,    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        title: { type: "string", minLength: 1, maxLength: 200 },
        description: { type: "string", maxLength: 5000 },
        priority: { type: "string", enum: ["NORMAL", "FLAGGED", "URGENT"] },
        poNumber: { type: "string" },
      },
    },
  },
  {
    name: "move_job",
    description:
      "Move a job to a different stage. Use list_stages to get stage IDs. Requires jobs:write.",
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: "object",
      required: ["jobId", "stageId"],
      properties: {
        jobId: { type: "string" },
        stageId: { type: "string" },
        reason: {
          type: "string",
          maxLength: 200,
          description: "Optional short note on why the job moved; kept on the team's activity record.",
        },
      },
    },
  },
  {
    name: "assign_job",
    description:
      "Assign a job to a team member, or pass assignedToId:null to unassign. Use list_members to get member IDs. Completed jobs are read-only: move_job it to an earlier stage first (the server returns 409 JOB_COMPLETED otherwise). Requires the mcp:assign scope. Available on every plan.",
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: "object",
      required: ["jobId", "assignedToId"],
      properties: {
        jobId: { type: "string" },
        assignedToId: { type: ["string", "null"], description: "Member user id, or null to unassign." },
      },
    },
  },
  {
    name: "list_tags",
    description: "List all tags defined on the workspace. Requires tags:read.",
    annotations: READ_ONLY,    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_members",
    description: "List team members with their roles. Requires members:read.",
    annotations: READ_ONLY,    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_tag",
    description: "Create a new tag for the workspace. Requires tags:write.",
    annotations: WRITE_NONDESTR,    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 40 },
        color: { type: "string" },
      },
    },
  },
  {
    name: "update_stage",
    description: "Rename a stage, change its SLA, or change its color. Requires stages:write.",
    annotations: WRITE_IDEMPOTENT,    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        name: { type: "string", minLength: 1, maxLength: 60 },
        slaDays: { type: "integer", minimum: 1, maximum: 365 },
        color: { type: "string" },
      },
    },
  },
  // --- Agent-collaboration primitives ---
  {
    name: "claim_job",
    description:
      "Atomically claim a job for this agent so other agents won't pick it up. Includes a lease (default 30 min, max 240) so a crashed agent does not lock the job forever. Requires mcp:claim scope. Returns CONFLICT if already claimed by someone else with a fresh lease.",
    annotations: WRITE_IDEMPOTENT,    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string" },
        leaseMinutes: { type: "integer", minimum: 1, maximum: 240, default: 30 },
        note: { type: "string", maxLength: 280 },
      },
    },
  },
  {
    name: "release_job",
    description: "Release a job this agent currently holds. Lets another actor pick it up. Requires mcp:claim.",
    annotations: WRITE_IDEMPOTENT,    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: { jobId: { type: "string" }, note: { type: "string", maxLength: 280 } },
    },
  },
  {
    name: "report_progress",
    description:
      "Append a 280-character narration entry to the job's timeline so the human can see what this agent has been doing. Call this at every meaningful step — humans skim, agents forget. Requires mcp:claim.",
    annotations: WRITE_NONDESTR,    inputSchema: {
      type: "object",
      required: ["jobId", "note"],
      properties: { jobId: { type: "string" }, note: { type: "string", minLength: 1, maxLength: 280 } },
    },
  },
  {
    name: "request_human_decision",
    description:
      "Ask the human team to pick one of 2-6 structured options. Creates a DecisionRequest that appears in their /my-tasks inbox. PREMIUM-plan only — FREE will receive PLAN_UPGRADE_REQUIRED with a structured upgrade prompt. Requires mcp:decide.",
    annotations: WRITE_NONDESTR,    inputSchema: {
      type: "object",
      required: ["jobId", "question", "options"],
      properties: {
        jobId: { type: "string" },
        question: { type: "string", minLength: 1, maxLength: 280 },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 6,
          items: {
            type: "object",
            required: ["id", "label"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 40 },
              label: { type: "string", minLength: 1, maxLength: 80 },
            },
          },
        },
        ttlDays: { type: "integer", minimum: 1, maximum: 30, default: 7 },
      },
    },
  },
  {
    name: "attach_evidence",
    description:
      "Attach a 280-character note and optional external URL as evidence that work was completed. URLs must be http(s) and never target internal/private hosts — they are display-only, never fetched server-side. PREMIUM-plan only. Requires mcp:evidence.",
    annotations: WRITE_NONDESTR,    inputSchema: {
      type: "object",
      required: ["jobId", "note"],
      properties: {
        jobId: { type: "string" },
        note: { type: "string", minLength: 1, maxLength: 280 },
        url: { type: "string", maxLength: 2048 },
      },
    },
  },
  {
    name: "get_timeline",
    description:
      "Read the most recent timeline entries for a job (claim/release/progress/decision/evidence). Helpful when the agent restarts a conversation and needs to know what happened. Requires jobs:read.",
    annotations: READ_ONLY,    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        cursor: { type: "string" },
      },
    },
  },
  {
    name: "list_decisions",
    description: "List open + recently resolved decision requests for a job. Use to poll for human response. Requires jobs:read.",
    annotations: READ_ONLY,    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } },
  },
  {
    name: "list_evidence",
    description: "List evidence attached to a job. PREMIUM-plan only. Requires jobs:read.",
    annotations: READ_ONLY,    inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } } },
  },
  {
    name: "resolve_decision",
    description:
      "Resolve a DecisionRequest you previously opened with request_human_decision. Use this when the human gave you the answer in your chat (not in the QodFlow board) — propagating it here keeps the board in sync. You MUST include `humanResponseExcerpt` with the human's actual reply (first 280 chars). Audit log captures the chat excerpt so the trail is verifiable. Requires mcp:resolve_decision scope.",
    annotations: WRITE_IDEMPOTENT,
    inputSchema: {
      type: "object",
      required: ["decisionId", "chosenOption", "humanResponseExcerpt"],
      properties: {
        decisionId: { type: "string" },
        chosenOption: { type: "string", minLength: 1, maxLength: 40 },
        humanResponseExcerpt: { type: "string", minLength: 1, maxLength: 280 },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "list_jobs") {
    const parsed = ListJobsArgs.parse(args ?? {});
    const qs = new URLSearchParams();
    if (parsed.limit) qs.set("limit", String(parsed.limit));
    if (parsed.cursor) qs.set("cursor", parsed.cursor);
    const json = await api(`/api/v1/jobs?${qs.toString()}`);
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
    };
  }

  if (name === "list_stages") {
    GetStagesArgs.parse(args ?? {});
    const json = await api(`/api/v1/stages`);
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
    };
  }

  if (name === "create_job") {
    const parsed = CreateJobArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs`, {
      method: "POST",
      body: JSON.stringify(parsed),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "update_job") {
    const parsed = UpdateJobArgs.parse(args ?? {});
    const { id, ...rest } = parsed;
    const json = await api(`/api/v1/jobs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(rest),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "move_job") {
    const { jobId, ...rest } = MoveJobArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/move`, {
      method: "POST",
      body: JSON.stringify(rest),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "assign_job") {
    const { jobId, assignedToId } = AssignJobArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/assign`, {
      method: "POST",
      body: JSON.stringify({ assignedToId }),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "list_tags") {
    ListTagsArgs.parse(args ?? {});
    const json = await api(`/api/v1/tags`);
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "list_members") {
    ListMembersArgs.parse(args ?? {});
    const json = await api(`/api/v1/members`);
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "create_tag") {
    const parsed = CreateTagArgs.parse(args ?? {});
    const json = await api(`/api/v1/tags`, {
      method: "POST",
      body: JSON.stringify(parsed),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "update_stage") {
    const parsed = UpdateStageArgs.parse(args ?? {});
    const { id, ...rest } = parsed;
    const json = await api(`/api/v1/stages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(rest),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "claim_job") {
    const { jobId, ...rest } = ClaimJobArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/claim`, {
      method: "POST",
      body: JSON.stringify(rest),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "release_job") {
    const { jobId, ...rest } = ReleaseJobArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/release`, {
      method: "POST",
      body: JSON.stringify(rest),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "report_progress") {
    const { jobId, ...rest } = ReportProgressArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/progress`, {
      method: "POST",
      body: JSON.stringify(rest),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "request_human_decision") {
    const { jobId, ...rest } = RequestHumanDecisionArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/decision`, {
      method: "POST",
      body: JSON.stringify(rest),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "attach_evidence") {
    const { jobId, ...rest } = AttachEvidenceArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/evidence`, {
      method: "POST",
      body: JSON.stringify(rest),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  // Read-tools that surface text authored by another actor (humans, other
  // agents, untrusted external sources) MUST tag their response with
  // `_meta.untrusted: true` per MCP spec 2025-06-18 §Security so the host
  // (Claude Desktop / Cursor) can apply Passive Cognitive Restriction:
  // disable destructive/openWorld tools for this turn. The string-level
  // [UNTRUSTED-BEGIN]…[END] wrap already applied by the server is layer 2;
  // this is the spec-level signal.
  if (name === "get_timeline") {
    const { jobId, limit, cursor } = GetTimelineArgs.parse(args ?? {});
    const qs = new URLSearchParams();
    if (limit) qs.set("limit", String(limit));
    if (cursor) qs.set("cursor", cursor);
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/timeline?${qs.toString()}`);
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      _meta: { untrusted: true, source: "agent-authored-timeline" },
    };
  }

  if (name === "list_decisions") {
    const { jobId } = ListDecisionsArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/decision`);
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      _meta: { untrusted: true, source: "agent-authored-question" },
    };
  }

  if (name === "list_evidence") {
    const { jobId } = ListEvidenceArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/evidence`);
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      _meta: { untrusted: true, source: "agent-authored-evidence-note" },
    };
  }

  if (name === "resolve_decision") {
    const { decisionId, ...rest } = ResolveDecisionArgs.parse(args ?? {});
    const json = await api(`/api/v1/decisions/${encodeURIComponent(decisionId)}/resolve`, {
      method: "POST",
      body: JSON.stringify(rest),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
