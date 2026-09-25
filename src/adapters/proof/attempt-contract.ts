import crypto from "node:crypto";
import type { TransferPacket } from "../../types.ts";

export type ResumeAttemptCode =
  | "REVISION_CONFLICT"
  | "TARGET_MISMATCH"
  | "BRANCH_MISMATCH"
  | "USER_ACCEPTANCE_REQUIRED"
  | "RESUMED";

export interface ResumeTargetV1 {
  surface: "local";
  name: string;
  session: string;
  capability: string;
}

export interface ResumeAttemptInputV1 {
  schema: "trajecta.resume-attempt/v1";
  operationId: string;
  packet: TransferPacket;
  target: ResumeTargetV1;
  expectedTarget: ResumeTargetV1;
  acceptedByUser: boolean;
}

export interface ResumeAttemptReceiptV1 {
  schema: "trajecta.resume-attempt-receipt/v1";
  receiptId: string;
  operationId: string;
  attemptDigest: string;
  outcome: "rejected" | "accepted";
  code: ResumeAttemptCode;
  workId: string;
  branchId: string | null;
  packetId: string;
  target: { surface: "local"; name: string; session: string };
  expectedRevision: number;
  observedRevisionBefore: number | null;
  observedRevisionAfter: number | null;
  provenance: string[];
  evidence: string[];
  createdAt: string;
}

const MAX_PROOF_PACKET_BYTES = 6_000;
const MAX_RECENT_DELTAS = 20;
const MAX_PROVENANCE = 20;
const MAX_OPEN_LOOPS = 20;
const MAX_BRANCH_CUES = 20;
const OPAQUE_ID = /^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORK_STATUSES = new Set(["active", "waiting", "blocked", "complete", "abandoned"]);
const BRANCH_STATUSES = new Set(["exploring", "parked", "merged"]);
const DELTA_KINDS = new Set(["open", "resume", "instruction", "decision", "progress", "blocker", "correction", "next_action", "branch_open", "branch_park", "synthesis", "handoff", "outcome", "contract_anchor"]);

function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, item]) => [key, normalize(item)]));
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new Error("Attempt contains a non-JSON value");
  }
  return value;
}

export function stableSerialize(value: unknown) {
  return JSON.stringify(normalize(value));
}

export function digestResumeAttempt(input: ResumeAttemptInputV1) {
  return crypto.createHash("sha256").update(stableSerialize(input)).digest("hex");
}

function bounded(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} is required and must not exceed ${max} characters`);
  }
}

function opaqueId(value: unknown, label: string) {
  bounded(value, label, 240);
  if (!OPAQUE_ID.test(value)) throw new Error(`${label} must be a namespaced opaque ID`);
}

function nonNegativeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a finite non-negative integer`);
  }
}

function boundedStrings(value: unknown, label: string, maxItems: number, maxLength: number, opaque = false) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must contain at most ${maxItems} entries`);
  value.forEach((item, index) => opaque ? opaqueId(item, `${label} ${index + 1}`) : bounded(item, `${label} ${index + 1}`, maxLength));
}

function surface(value: unknown, label: string) {
  const candidate = value as { kind?: unknown; name?: unknown; session?: unknown } | null;
  if (!candidate || !["cloud", "local"].includes(candidate.kind as string)) throw new Error(`${label} kind must be cloud or local`);
  bounded(candidate.name, `${label} name`, 120);
  opaqueId(candidate.session, `${label} session`);
}

function timestamp(value: unknown, label: string) {
  bounded(value, label, 64);
  if (Number.isNaN(Date.parse(value as string))) throw new Error(`${label} must be an ISO timestamp`);
}

function branch(value: unknown) {
  if (value === null) return;
  const candidate = value as Record<string, unknown> | null;
  if (!candidate) throw new Error("Packet active branch is required");
  opaqueId(candidate.id, "Packet branch ID");
  bounded(candidate.label, "Packet branch label", 120);
  bounded(candidate.purpose, "Packet branch purpose", 500);
  bounded(candidate.returnPoint, "Packet branch return point", 500);
  boundedStrings(candidate.cues, "Packet branch cues", MAX_BRANCH_CUES, 500);
  if (!BRANCH_STATUSES.has(candidate.status as string)) throw new Error("Packet branch status is invalid");
  timestamp(candidate.updatedAt, "Packet branch timestamp");
}

function delta(value: unknown, label: string, maxSummary = 1_000) {
  const candidate = value as Record<string, unknown> | null;
  if (!candidate) throw new Error(`${label} is required`);
  opaqueId(candidate.id, `${label} ID`);
  nonNegativeInteger(candidate.revision, `${label} revision`);
  if (!DELTA_KINDS.has(candidate.kind as string)) throw new Error(`${label} kind is invalid`);
  bounded(candidate.summary, `${label} summary`, maxSummary);
  boundedStrings(candidate.provenance, `${label} provenance`, MAX_PROVENANCE, 240, true);
  timestamp(candidate.createdAt, `${label} timestamp`);
}

function contractAnchor(value: unknown) {
  const candidate = value as Record<string, unknown> | null;
  if (!candidate) throw new Error("Packet contract anchor is required");
  opaqueId(candidate.id, "Packet contract anchor ID");
  nonNegativeInteger(candidate.contractVersion, "Packet contract anchor version");
  bounded(candidate.summary, "Packet contract anchor summary", 8_000);
  boundedStrings(candidate.provenance, "Packet contract anchor provenance", MAX_PROVENANCE, 240, true);
  timestamp(candidate.createdAt, "Packet contract anchor timestamp");
}

export function assertTransferPacket(packet: unknown): asserts packet is TransferPacket {
  const candidate = packet as Record<string, unknown> | null;
  if (!candidate || candidate.schema !== "trajecta.transfer/v1") throw new Error("Unsupported transfer packet schema");
  opaqueId(candidate.packetId, "Packet ID");
  timestamp(candidate.createdAt, "Packet timestamp");
  bounded(candidate.cue, "Packet cue", 500);
  surface(candidate.from, "Packet source");
  if (!['cloud', 'local'].includes(candidate.intendedFor as string)) throw new Error("Packet intended surface is invalid");

  const work = candidate.work as Record<string, unknown> | null;
  if (!work) throw new Error("Packet work is required");
  opaqueId(work.id, "Work ID");
  bounded(work.topic, "Work topic", 160);
  bounded(work.goal, "Work goal", 1_000);
  if (work.instruction !== null) bounded(work.instruction, "Work instruction", 1_000);
  if (!WORK_STATUSES.has(work.status as string)) throw new Error("Work status is invalid");
  nonNegativeInteger(work.revision, "Work revision");
  boundedStrings(work.openLoops, "Work open loops", MAX_OPEN_LOOPS, 500);
  if (work.nextAction !== null) bounded(work.nextAction, "Work next action", 1_000);

  branch(candidate.activeBranch);
  if (!Array.isArray(candidate.recentDeltas) || candidate.recentDeltas.length > MAX_RECENT_DELTAS) {
    throw new Error(`Packet deltas must contain at most ${MAX_RECENT_DELTAS} entries`);
  }
  candidate.recentDeltas.forEach((item, index) => delta(item, `Packet delta ${index + 1}`));
  if (candidate.contractAnchor !== undefined) contractAnchor(candidate.contractAnchor);

  const resume = candidate.resume as Record<string, unknown> | null;
  if (!resume) throw new Error("Packet resume is required");
  nonNegativeInteger(resume.expectedRevision, "Expected revision");
  bounded(resume.rule, "Resume rule", 1_000);

  const budget = candidate.budget as Record<string, unknown> | null;
  if (!budget) throw new Error("Packet budget is required");
  nonNegativeInteger(budget.maxBytes, "Packet budget max bytes");
  nonNegativeInteger(budget.usedBytes, "Packet budget used bytes");
  if ((budget.maxBytes as number) < 900 || (budget.maxBytes as number) > MAX_PROOF_PACKET_BYTES) {
    throw new Error(`Packet budget must be between 900 and ${MAX_PROOF_PACKET_BYTES} bytes`);
  }
  if (typeof budget.truncated !== "boolean") throw new Error("Packet budget truncated must be boolean");
  const serializedBytes = Buffer.byteLength(stableSerialize(candidate), "utf8");
  if (serializedBytes > MAX_PROOF_PACKET_BYTES) throw new Error(`Packet exceeds ${MAX_PROOF_PACKET_BYTES}-byte proof ceiling`);
  if (budget.usedBytes !== serializedBytes || (budget.usedBytes as number) > (budget.maxBytes as number)) {
    throw new Error("Packet budget used bytes must match the serialized packet and remain within max bytes");
  }
}

export function assertResumeAttempt(input: ResumeAttemptInputV1) {
  if (input?.schema !== "trajecta.resume-attempt/v1") throw new Error("Unsupported resume attempt schema");
  opaqueId(input.operationId, "Operation ID");
  assertTransferPacket(input.packet);
  bounded(input.target?.name, "Target name", 120);
  opaqueId(input.target?.session, "Target session");
  opaqueId(input.target?.capability, "Target capability");
  bounded(input.expectedTarget?.name, "Expected target name", 120);
  opaqueId(input.expectedTarget?.session, "Expected target session");
  opaqueId(input.expectedTarget?.capability, "Expected target capability");
  if (input.target.surface !== "local" || input.expectedTarget.surface !== "local") throw new Error("Proof target must be local");
  if (typeof input.acceptedByUser !== "boolean") throw new Error("acceptedByUser must be boolean");
  stableSerialize(input);
}
