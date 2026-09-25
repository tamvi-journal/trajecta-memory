import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defaultRoot, surfaceFrom, TOOLS, WorkServer } from "../src/mcp.ts";
import { TrajectaStore } from "../src/store.ts";

function server(kind: "cloud" | "local" = "local") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-mcp-"));
  return new WorkServer(new TrajectaStore(root), { kind, name: kind === "local" ? "Local" : "Cloud", session: `${kind}:test` });
}

function call(s: WorkServer, name: string, args: Record<string, unknown> = {}) {
  const response = s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any;
  return response.result;
}

test("initialize and list tools", () => {
  const s = server();
  const init = s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) as any;
  assert.equal(init.result.serverInfo.name, "trajecta-work-memory");
  const listed = s.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any;
  assert.deepEqual(listed.result.tools.map((t: any) => t.name), TOOLS.map((t) => t.name));
  assert.equal(s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("open, capture, route, get and packet round trip", () => {
  const s = server();
  const opened = call(s, "work_open", {
    topic: "Ship identity memory", goal: "One package",
    branch: { label: "merge", purpose: "Merge repos", cues: ["identity", "merge"], return_point: "CI green" },
  }).structuredContent;
  const id = opened.work.id;
  assert.equal(opened.work.active_branch, "merge");
  const captured = call(s, "work_capture", {
    work_id: id, expected_revision: 1, kind: "decision", summary: "Merge kernel into identity",
    open_loops: ["web view"], next_action: "Build the view",
  });
  assert.equal(captured.isError, false);
  assert.equal(captured.structuredContent.work.revision, 2);
  assert.equal(call(s, "work_route", { cue: "identity merge" }).structuredContent.matches[0].workId, id);
  const got = call(s, "work_get", { work_id: id }).structuredContent;
  assert.deepEqual(got.recent_deltas.map((d: any) => d.kind), ["open", "decision"]);
  assert.equal(got.work.next_action, "Build the view");
  const packet = call(s, "work_packet", { work_id: id, cue: "view", target: "cloud" }).structuredContent.packet;
  assert.equal(packet.schema, "trajecta.transfer/v1");
  assert.equal(packet.resume.expectedRevision, 2);
});

test("stale revision is an error with guidance, not an overwrite", () => {
  const s = server();
  const id = call(s, "work_open", { topic: "T", goal: "G" }).structuredContent.work.id;
  call(s, "work_capture", { work_id: id, expected_revision: 1, kind: "progress", summary: "one" });
  const stale = call(s, "work_capture", { work_id: id, expected_revision: 1, kind: "progress", summary: "two" });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /retry with revision 2/);
  assert.equal(call(s, "work_get", { work_id: id }).structuredContent.work.revision, 2);
});

test("handoff from local produces a cloud packet; resume on the other side", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-mcp-"));
  const local = new WorkServer(new TrajectaStore(root), { kind: "local", name: "Local", session: "local:t" });
  const cloud = new WorkServer(new TrajectaStore(root), { kind: "cloud", name: "Cloud", session: "cloud:t" });
  const id = call(local, "work_open", { topic: "T", goal: "G" }).structuredContent.work.id;
  const handed = call(local, "work_handoff", { work_id: id, expected_revision: 1, summary: "Built it", cue: "review" }).structuredContent;
  assert.equal(handed.packet.intendedFor, "cloud");
  const resumed = call(cloud, "work_resume", { work_id: id, expected_revision: handed.packet.resume.expectedRevision });
  assert.equal(resumed.isError, false);
});

test("operation_id makes retries idempotent", () => {
  const s = server();
  const a = call(s, "work_open", { topic: "T", goal: "G", operation_id: "op:x" }).structuredContent.work.id;
  const b = call(s, "work_open", { topic: "T", goal: "G", operation_id: "op:x" }).structuredContent.work.id;
  assert.equal(a, b);
  assert.equal(call(s, "work_list").structuredContent.work.length, 1);
});

test("data root and surface come from the environment", () => {
  assert.equal(defaultRoot({ TRAJECTA_HOME: "/tmp/x" }), path.resolve("/tmp/x"));
  assert.equal(defaultRoot({ HOME: "/Users/ty" }, "darwin"), path.join("/Users/ty", "Library", "Application Support", "Trajecta Work Memory"));
  assert.equal(defaultRoot({ HOME: "/home/ty" }, "linux"), path.join("/home/ty", ".local", "share", "trajecta-work-memory"));
  assert.deepEqual(surfaceFrom({ TRAJECTA_SURFACE_KIND: "cloud", TRAJECTA_SURFACE_NAME: "Claude" }), { kind: "cloud", name: "Claude", session: "cloud:mcp" });
  assert.throws(() => surfaceFrom({ TRAJECTA_SURFACE_KIND: "moon" }));
});

test("stdio entry point answers a request", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-mcp-"));
  const entry = fileURLToPath(new URL("../src/mcp-server.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "work_list", arguments: {} } })}\n`,
    env: { ...process.env, TRAJECTA_HOME: root },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()).result.structuredContent, { work: [] });
});
