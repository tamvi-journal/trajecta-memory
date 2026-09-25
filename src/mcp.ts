/**
 * Stdio MCP server for Trajecta work memory (JSON-RPC, one message per line).
 *
 * No network listener and no dependencies. The store is single-writer: run one
 * server per store. Every write carries the expected revision, so a stale
 * surface gets a RevisionConflict instead of overwriting newer work.
 */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { RevisionConflict, TrajectaStore } from "./store.ts";
import { TrajectaRelay } from "./relay.ts";
import type { DeltaKind, Surface, SurfaceKind } from "./types.ts";

export const SERVER_NAME = "trajecta-work-memory";
export const SERVER_VERSION = "0.2.0";
const CAPTURE_KINDS: DeltaKind[] = [
  "instruction", "decision", "progress", "blocker", "correction", "next_action",
  "branch_open", "branch_park", "synthesis", "outcome", "contract_anchor",
];

type Json = Record<string, unknown>;

/** Platform data folder; TRAJECTA_HOME overrides it. */
export function defaultRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.TRAJECTA_HOME?.trim()) return path.resolve(env.TRAJECTA_HOME);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Trajecta Work Memory");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Trajecta Work Memory");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "trajecta-work-memory");
}

export function surfaceFrom(env: NodeJS.ProcessEnv = process.env): Surface {
  const kind = (env.TRAJECTA_SURFACE_KIND || "local") as SurfaceKind;
  if (kind !== "cloud" && kind !== "local") throw new Error("TRAJECTA_SURFACE_KIND must be cloud or local");
  return {
    kind,
    name: env.TRAJECTA_SURFACE_NAME || (kind === "local" ? "Local agent" : "Cloud agent"),
    session: env.TRAJECTA_SURFACE_SESSION || `${kind}:mcp`,
  };
}

const str = { type: "string" };
const strs = { type: "array", items: str, maxItems: 20 };
const rev = { type: "integer", minimum: 1 };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
function tool(name: string, description: string, properties: Json = {}, required: string[] = [], annotations = RO) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations };
}
const opId = { type: "string", maxLength: 200, description: "Optional idempotency key such as operation:abc-123. Retrying with the same key and input returns the same result." };

export const TOOLS = [
  tool("work_list", "List work items: id, topic, status, revision, next action, open loops."),
  tool("work_route", "Find the work item a cue belongs to. Returns compact candidates only.",
    { cue: { type: "string", minLength: 1, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 10 } }, ["cue"]),
  tool("work_get", "Read one work item and its most recent deltas (decisions, blockers, outcomes…).",
    { work_id: str, recent: { type: "integer", minimum: 0, maximum: 50 } }, ["work_id"]),
  tool("work_open", "Open a new work item. Optionally start a branch with a purpose, cues and a return point.",
    {
      topic: { type: "string", minLength: 1, maxLength: 200 },
      goal: { type: "string", minLength: 1, maxLength: 1000 },
      instruction: { type: "string", maxLength: 1000 },
      branch: {
        type: "object",
        properties: { label: str, purpose: str, cues: strs, return_point: str },
        required: ["label", "purpose", "cues", "return_point"],
        additionalProperties: false,
      },
      operation_id: opId,
    }, ["topic", "goal"], W),
  tool("work_capture", "Record a material change: a decision, progress, blocker, correction, next action, outcome, synthesis, or a branch opening/parking. Needs the current revision; a stale revision is rejected.",
    {
      work_id: str,
      expected_revision: rev,
      kind: { type: "string", enum: CAPTURE_KINDS },
      summary: { type: "string", minLength: 1, maxLength: 1000 },
      provenance: strs,
      open_loops: strs,
      next_action: { type: ["string", "null"], maxLength: 1000 },
      branch_id: str,
      branch: {
        type: "object",
        properties: { label: str, purpose: str, cues: strs, return_point: str },
        required: ["label", "purpose", "cues", "return_point"],
        additionalProperties: false,
      },
      operation_id: opId,
    }, ["work_id", "expected_revision", "kind", "summary"], W),
  tool("work_handoff", "Hand work to the other surface (cloud ⇄ local). Records the handoff and returns a bounded transfer packet.",
    {
      work_id: str,
      expected_revision: rev,
      summary: { type: "string", minLength: 1, maxLength: 1000 },
      cue: { type: "string", minLength: 1, maxLength: 500 },
      provenance: strs,
      open_loops: strs,
      next_action: { type: ["string", "null"], maxLength: 1000 },
      operation_id: opId,
    }, ["work_id", "expected_revision", "summary", "cue"], W),
  tool("work_resume", "Resume work on this surface at the expected revision.",
    { work_id: str, expected_revision: rev, instruction: { type: "string", maxLength: 1000 }, operation_id: opId },
    ["work_id", "expected_revision"], W),
  tool("work_packet", "Render a bounded transfer packet for one work item without changing anything.",
    { work_id: str, cue: { type: "string", minLength: 1, maxLength: 500 }, target: { type: "string", enum: ["cloud", "local"] } },
    ["work_id", "cue", "target"]),
];

function summarize(item: ReturnType<TrajectaStore["getWork"]>) {
  const branch = item.branches.find((candidate) => candidate.id === item.activeBranchId);
  return {
    id: item.id, topic: item.topic, goal: item.goal, status: item.status, revision: item.revision,
    next_action: item.nextAction, open_loops: item.openLoops, active_branch: branch?.label ?? null,
    last_surface: item.lastSurface, updated_at: item.updatedAt,
  };
}

function branchInput(value: unknown) {
  if (!value) return undefined;
  const b = value as { label: string; purpose: string; cues: string[]; return_point: string };
  return { label: b.label, purpose: b.purpose, cues: b.cues, returnPoint: b.return_point };
}

export class WorkServer {
  readonly store: TrajectaStore;
  readonly surface: Surface;
  constructor(store: TrajectaStore, surface: Surface) {
    this.store = store;
    this.surface = surface;
  }

  private op(args: Json) {
    const given = typeof args.operation_id === "string" ? args.operation_id.trim() : "";
    return given || `operation:mcp-${crypto.randomUUID()}`;
  }

  callTool(name: string, args: Json): unknown {
    const s = this.store;
    switch (name) {
      case "work_list":
        return { work: s.list().map(summarize) };
      case "work_route":
        return { matches: s.route(String(args.cue), Number(args.limit ?? 3)) };
      case "work_get": {
        const item = s.getWork(String(args.work_id));
        const recent = Number(args.recent ?? 8);
        const deltas = s.history(item.id).slice(-recent).map((d) => ({
          id: d.id, revision: d.revision, kind: d.kind, summary: d.summary, provenance: d.provenance, created_at: d.createdAt,
        }));
        return { work: summarize(item), branches: item.branches, recent_deltas: recent ? deltas : [] };
      }
      case "work_open": {
        const opened = s.open({
          operationId: this.op(args), topic: String(args.topic), goal: String(args.goal), surface: this.surface,
          instruction: typeof args.instruction === "string" ? args.instruction : undefined,
          initialBranch: branchInput(args.branch),
        });
        return { work: summarize(opened.work) };
      }
      case "work_capture": {
        const captured = s.capture({
          operationId: this.op(args), workId: String(args.work_id), expectedRevision: Number(args.expected_revision),
          surface: this.surface, kind: args.kind as DeltaKind, summary: String(args.summary),
          provenance: (args.provenance as string[]) ?? [], openLoops: args.open_loops as string[] | undefined,
          nextAction: args.next_action as string | null | undefined,
          branchId: args.branch_id as string | undefined, branch: branchInput(args.branch),
        });
        return { work: summarize(captured.work), delta: { id: captured.delta.id, revision: captured.delta.revision } };
      }
      case "work_handoff": {
        const target: SurfaceKind = this.surface.kind === "cloud" ? "local" : "cloud";
        const current = s.getWork(String(args.work_id));
        const result = new TrajectaRelay(s, this.surface).handoff({
          operationId: this.op(args), workId: String(args.work_id), expectedRevision: Number(args.expected_revision),
          summary: String(args.summary), cue: String(args.cue), target,
          provenance: (args.provenance as string[]) ?? [],
          openLoops: (args.open_loops as string[] | undefined) ?? current.openLoops,
          nextAction: args.next_action === undefined ? current.nextAction : (args.next_action as string | null),
        });
        return { work: summarize(result.work), packet: result.packet, receipt: result.receipt };
      }
      case "work_resume": {
        const resumed = s.resume({
          operationId: this.op(args), workId: String(args.work_id), expectedRevision: Number(args.expected_revision),
          surface: this.surface, instruction: typeof args.instruction === "string" ? args.instruction : undefined,
        });
        return { work: summarize(resumed.work) };
      }
      case "work_packet":
        return { packet: s.transfer(String(args.work_id), String(args.cue), args.target as SurfaceKind) };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  handle(request: Json): Json | null {
    const id = request.id;
    if (id === undefined || id === null) return null;
    const method = request.method;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      const params = (request.params ?? {}) as Json;
      return ok({
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: `Work memory for the ${this.surface.kind} surface "${this.surface.name}". Route by cue, then read, capture or hand off with the expected revision.`,
      });
    }
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools: TOOLS });
    if (method === "tools/call") {
      const params = (request.params ?? {}) as Json;
      try {
        const result = this.callTool(String(params.name ?? ""), (params.arguments ?? {}) as Json);
        const text = JSON.stringify(result);
        return ok({ content: [{ type: "text", text }], structuredContent: JSON.parse(text), isError: false });
      } catch (error) {
        const message = error instanceof RevisionConflict
          ? `${error.message}. Read the work again (work_get) and retry with revision ${error.latest.revision}.`
          : `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;
        return ok({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${String(method)}` } };
  }
}

export async function runStdio(env: NodeJS.ProcessEnv = process.env) {
  const server = new WorkServer(new TrajectaStore(defaultRoot(env)), surfaceFrom(env));
  process.stdin.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = server.handle(JSON.parse(line));
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      }
    }
  }
}
