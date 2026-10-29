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
import {
  ListJobsArgs,
  GetStagesArgs,
  CreateJobArgs,
  ListTemplatesArgs,
  GetBriefingArgs,
  AckDecisionArgs,
  UpdateJobArgs,
  AddTagArgs,
  RemoveTagArgs,
  ListChecklistArgs,
  AddChecklistItemArgs,
  SetChecklistItemArgs,
  ListTagsArgs,
  ListMembersArgs,
  CreateTagArgs,
  UpdateStageArgs,
  AssignJobArgs,
  MoveJobArgs,
  ClaimJobArgs,
  ReleaseJobArgs,
  ReportProgressArgs,
  RequestHumanDecisionArgs,
  AttachEvidenceArgs,
  GetTimelineArgs,
  ListDecisionsArgs,
  ListEvidenceArgs,
  ResolveDecisionArgs,
  TOOLS,
} from "./tools.js";

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
      "User-Agent": "qodflow-mcp/0.2.0",
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


// Server setup
const INSTRUCTIONS =
  "Call get_briefing first in every session: it lists decisions waiting on humans, approvals you have not acknowledged, jobs you still hold, and new human notes. " +
  "An EXPIRED decision means do not proceed. Acknowledge each resolved decision with ack_decision.";

const server = new Server(
  { name: "qodflow", version: "0.2.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

// The briefing is attached once, to the first successful tool result of this process (one stdio process = one
// client session). It never blocks a tool: 2 s timeout, any failure is skipped, at most 2 attempts.
let briefed = false;
let briefingAttempts = 0;
const BRIEFING_HEADER = "--- QodFlow briefing ---";

async function fetchBriefingBlock(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/agent/briefing`, {
      headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": "qodflow-mcp/0.2.0" },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: unknown };
    return `${BRIEFING_HEADER}\n${JSON.stringify(json.data ?? json, null, 2)}`;
  } catch {
    return null;
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const result = await callTool(req.params.name, req.params.arguments);
  if (req.params.name === "get_briefing") briefed = true;
  if (!briefed && briefingAttempts < 2) {
    briefingAttempts++;
    const block = await fetchBriefingBlock();
    if (block) {
      briefed = true;
      return {
        ...result,
        content: [{ type: "text", text: block }, ...result.content],
        _meta: { ...(result._meta ?? {}), untrusted: true, source: "user-authored-briefing" },
      };
    }
  }
  return result;
});

type ToolResult = { content: Array<{ type: "text"; text: string }>; _meta?: Record<string, unknown> };

async function callTool(name: string, args: unknown): Promise<ToolResult> {
  if (name === "list_templates") {
    ListTemplatesArgs.parse(args ?? {});
    const json = await api(`/api/v1/templates`);
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      _meta: { untrusted: true, source: "user-authored-template" },
    };
  }

  if (name === "get_briefing") {
    GetBriefingArgs.parse(args ?? {});
    const json = await api(`/api/v1/agent/briefing`);
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      _meta: { untrusted: true, source: "user-authored-briefing" },
    };
  }

  if (name === "ack_decision") {
    const { decisionId } = AckDecisionArgs.parse(args ?? {});
    const json = await api(`/api/v1/decisions/${encodeURIComponent(decisionId)}/ack`, { method: "POST", body: JSON.stringify({}) });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "list_jobs") {
    const parsed = ListJobsArgs.parse(args ?? {});
    const qs = new URLSearchParams();
    if (parsed.limit) qs.set("limit", String(parsed.limit));
    if (parsed.cursor) qs.set("cursor", parsed.cursor);
    const { limit: _l, cursor: _c, ...filters } = parsed;
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined) qs.set(k, String(v));
    }
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

  if (name === "add_tag") {
    const { jobId, tagId } = AddTagArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/tags`, {
      method: "POST",
      body: JSON.stringify({ tagId }),
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "remove_tag") {
    const { jobId, tagId } = RemoveTagArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/tags?tagId=${encodeURIComponent(tagId)}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  }

  if (name === "list_checklist") {
    const { jobId } = ListChecklistArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/checklist`);
    // Item text is authored by humans and other agents: flag it as untrusted for the host.
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      _meta: { untrusted: true, source: "user-authored-checklist" },
    };
  }

  if (name === "add_checklist_item") {
    const { jobId, text } = AddChecklistItemArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/checklist`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    // The result echoes item text (user-authored): flag it untrusted like list_checklist.
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      _meta: { untrusted: true, source: "user-authored-checklist" },
    };
  }

  if (name === "set_checklist_item") {
    const { jobId, ...rest } = SetChecklistItemArgs.parse(args ?? {});
    const json = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/checklist`, {
      method: "PATCH",
      body: JSON.stringify(rest),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
      _meta: { untrusted: true, source: "user-authored-checklist" },
    };
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
}

const transport = new StdioServerTransport();
await server.connect(transport);
