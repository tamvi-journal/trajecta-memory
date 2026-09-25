import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertResumeAttempt,
  attemptVerifiedResume,
  digestResumeAttempt,
  inspectVerifiedResume,
  OperationConflict,
  ResumeAttemptLedger,
  stableSerialize,
  TrajectaStore,
  renderResumeReceipt,
} from "../src/index.ts";
import type { ResumeAttemptInputV1, ResumeAttemptReceiptV1, Surface } from "../src/index.ts";

test("proof digest is independent of object insertion order", () => {
  const left = { z: 1, nested: { b: true, a: "x" }, list: [2, 1] };
  const right = { list: [2, 1], nested: { a: "x", b: true }, z: 1 };
  assert.equal(stableSerialize(left), stableSerialize(right));
});

test("proof digest changes when a material attempt field changes", () => {
  const base = {
    schema: "trajecta.resume-attempt/v1" as const,
    operationId: "operation:proof-attempt",
    packet: { schema: "trajecta.transfer/v1" },
    target: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    expectedTarget: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    acceptedByUser: true,
  };
  assert.notEqual(digestResumeAttempt(base as never), digestResumeAttempt({ ...base, acceptedByUser: false } as never));
});

test("attempt validation rejects unsupported schemas and unbounded fields", () => {
  assert.throws(() => assertResumeAttempt({ schema: "wrong" } as never), /attempt schema/i);
  assert.throws(() => assertResumeAttempt({
    schema: "trajecta.resume-attempt/v1",
    operationId: `operation:${"x".repeat(300)}`,
    packet: { schema: "trajecta.transfer/v1" },
    target: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    expectedTarget: { surface: "local", name: "Codex", session: "local:proof", capability: "capability:proof" },
    acceptedByUser: true,
  } as never), /operation/i);
});

function receipt(overrides: Partial<ResumeAttemptReceiptV1> = {}): ResumeAttemptReceiptV1 {
  return {
    schema: "trajecta.resume-attempt-receipt/v1",
    receiptId: "receipt:proof-one",
    operationId: "operation:proof-one",
    attemptDigest: "a".repeat(64),
    outcome: "rejected",
    code: "REVISION_CONFLICT",
    workId: "work:proof",
    branchId: "branch:proof",
    packetId: "packet:proof",
    target: { surface: "local", name: "Codex", session: "local:proof" },
    expectedRevision: 2,
    observedRevisionBefore: 3,
    observedRevisionAfter: 3,
    provenance: ["artifact:proof-contract-v1"],
    evidence: ["test:adapter-proof"],
    createdAt: "2026-09-04T00:00:00.000Z",
    ...overrides,
  };
}

test("attempt ledger returns one committed receipt for equivalent replay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-proof-ledger-"));
  try {
    const ledger = new ResumeAttemptLedger(root);
    const first = receipt();
    assert.deepEqual(ledger.commit(first), first);
    assert.deepEqual(ledger.replay(first.operationId, first.attemptDigest), first);
    assert.deepEqual(ledger.commit(first), first);
    assert.equal(ledger.history().length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("attempt ledger rejects altered operation reuse without appending", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-proof-ledger-"));
  try {
    const ledger = new ResumeAttemptLedger(root);
    ledger.commit(receipt());
    assert.throws(() => ledger.replay("operation:proof-one", "b".repeat(64)), OperationConflict);
    assert.equal(ledger.history().length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const proofNow = new Date("2026-09-04T00:00:00.000Z");
const cloud: Surface = { kind: "cloud", name: "ChatGPT fixture", session: "cloud:proof" };
const localTarget = {
  surface: "local" as const,
  name: "Codex fixture",
  session: "local:proof",
  capability: "capability:codex-proof",
};

function proofFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-proof-"));
  const store = new TrajectaStore(root, () => proofNow);
  const ledger = new ResumeAttemptLedger(root);
  const opened = store.open({
    operationId: "operation:proof-open",
    topic: "Adapter Slice 1 proof",
    goal: "Prove stale rejection and exact resume",
    surface: cloud,
    initialBranch: {
      label: "verified-resume-proof",
      purpose: "Build the smallest falsifiable adapter proof",
      cues: ["verified", "resume", "proof"],
      returnPoint: "Compare accepted and rejected receipts",
    },
  });
  const handoff = store.capture({
    operationId: "operation:proof-handoff-v1",
    workId: opened.work.id,
    expectedRevision: opened.work.revision,
    surface: cloud,
    kind: "handoff",
    summary: "Plausible first plan ready for local work",
    provenance: ["artifact:proof-contract-v1"],
    openLoops: ["Run proof"],
    nextAction: "Implement the first plan",
    targetSurface: "local",
  });
  const stale = store.transfer(opened.work.id, "resume proof", "local");
  const revised = store.capture({
    operationId: "operation:proof-decision-v2",
    workId: opened.work.id,
    expectedRevision: handoff.work.revision,
    surface: cloud,
    kind: "decision",
    summary: "Use the verified current plan instead",
    provenance: ["artifact:proof-contract-v2"],
    openLoops: ["Run proof"],
    nextAction: "Implement the verified adapter proof",
  });
  const current = store.transfer(opened.work.id, "resume verified proof", "local");
  return { root, store, ledger, opened, revised, stale, current };
}

function attempt(packet: ReturnType<TrajectaStore["transfer"]>, operationId: string): ResumeAttemptInputV1 {
  return {
    schema: "trajecta.resume-attempt/v1",
    operationId,
    packet,
    target: localTarget,
    expectedTarget: localTarget,
    acceptedByUser: true,
  };
}

test("attempt validation rejects an oversized provenance entry before resume", () => {
  const f = proofFixture();
  try {
    const oversized = structuredClone(f.current);
    oversized.recentDeltas[0]!.provenance = [`artifact:${"x".repeat(20_000)}`];
    assert.throws(
      () => assertResumeAttempt(attempt(oversized, "operation:oversized-provenance")),
      /provenance/i,
    );
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt validation rejects malformed packet bounds, IDs, revisions, and budget", () => {
  const f = proofFixture();
  try {
    const cases: Array<{ name: string; mutate: (packet: ReturnType<TrajectaStore["transfer"]>) => void; error: RegExp }> = [
      { name: "serialized ceiling", mutate: (packet) => { packet.budget.maxBytes = 10_000; }, error: /budget/i },
      { name: "delta collection", mutate: (packet) => { packet.recentDeltas = Array.from({ length: 21 }, () => structuredClone(packet.recentDeltas[0]!)); }, error: /delta/i },
      { name: "packet ID", mutate: (packet) => { packet.packetId = "packet bad"; }, error: /packet id/i },
      { name: "work revision", mutate: (packet) => { packet.work.revision = Number.NaN; }, error: /work revision/i },
      { name: "expected revision", mutate: (packet) => { packet.resume.expectedRevision = -1; }, error: /expected revision/i },
      { name: "used bytes", mutate: (packet) => { packet.budget.usedBytes += 1; }, error: /used bytes/i },
    ];
    for (const { name, mutate, error } of cases) {
      const packet = structuredClone(f.current);
      mutate(packet);
      assert.throws(() => assertResumeAttempt(attempt(packet, `operation:packet-${name.replace(" ", "-")}`)), error, name);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("attempt validation accepts a real bounded contract anchor packet", () => {
  const f = proofFixture();
  try {
    const anchored = f.store.capture({
      operationId: "operation:proof-contract-anchor",
      workId: f.opened.work.id,
      expectedRevision: f.current.work.revision,
      surface: cloud,
      kind: "contract_anchor",
      summary: "Verified resume proof contract anchor",
      provenance: ["artifact:proof-contract-v2"],
    });
    const packet = f.store.transfer(anchored.work.id, "resume anchored proof", "local", 6_000, true);
    assert.ok(packet.contractAnchor);
    assert.doesNotThrow(() => assertResumeAttempt(attempt(packet, "operation:contract-anchor-packet")));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("P01 fixture binds one exact work and active branch", () => {
  const f = proofFixture();
  try {
    assert.equal(f.store.list().length, 1);
    assert.equal(f.current.work.id, f.opened.work.id);
    assert.equal(f.current.activeBranch?.id, f.revised.work.activeBranchId);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("P02 inspection is read-only and exposes expected versus current revision", () => {
  const f = proofFixture();
  try {
    const beforeWork = f.store.getWork(f.opened.work.id);
    const beforeHistory = f.store.history(f.opened.work.id);
    const beforeAttempts = f.ledger.history();
    const view = inspectVerifiedResume({ store: f.store, input: attempt(f.stale, "operation:proof-inspect") });
    assert.equal(view.workId, f.opened.work.id);
    assert.equal(view.branchId, f.revised.work.activeBranchId);
    assert.equal(view.expectedRevision, f.stale.resume.expectedRevision);
    assert.equal(view.currentRevision, f.revised.work.revision);
    assert.deepEqual(f.store.getWork(f.opened.work.id), beforeWork);
    assert.deepEqual(f.store.history(f.opened.work.id), beforeHistory);
    assert.deepEqual(f.ledger.history(), beforeAttempts);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("P03-P04 stale resume emits a durable zero-mutation rejection", () => {
  const f = proofFixture();
  try {
    const beforeWork = f.store.getWork(f.opened.work.id);
    const beforeHistory = f.store.history(f.opened.work.id);
    const rejected = attemptVerifiedResume({
      store: f.store, ledger: f.ledger,
      input: attempt(f.stale, "operation:proof-stale"), clock: () => proofNow,
    });
    assert.equal(rejected.code, "REVISION_CONFLICT");
    assert.equal(rejected.outcome, "rejected");
    assert.equal(rejected.observedRevisionBefore, f.revised.work.revision);
    assert.equal(rejected.observedRevisionAfter, f.revised.work.revision);
    assert.deepEqual(f.store.getWork(f.opened.work.id), beforeWork);
    assert.deepEqual(f.store.history(f.opened.work.id), beforeHistory);
    assert.deepEqual(f.ledger.replay(rejected.operationId, rejected.attemptDigest), rejected);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("P05-P06 target and branch mismatches fail before kernel mutation", () => {
  const f = proofFixture();
  try {
    const before = f.store.getWork(f.opened.work.id);
    const wrongTarget = attemptVerifiedResume({
      store: f.store, ledger: f.ledger,
      input: {
        ...attempt(f.current, "operation:wrong-target"),
        target: { ...localTarget, session: "local:other" },
      },
      clock: () => proofNow,
    });
    assert.equal(wrongTarget.code, "TARGET_MISMATCH");
    assert.equal(wrongTarget.observedRevisionBefore, null);
    assert.equal(wrongTarget.observedRevisionAfter, null);
    const wrongBranchPacket = structuredClone(f.current);
    wrongBranchPacket.activeBranch!.id = "branch:other";
    wrongBranchPacket.budget.usedBytes = Buffer.byteLength(JSON.stringify(wrongBranchPacket), "utf8");
    const wrongBranch = attemptVerifiedResume({
      store: f.store, ledger: f.ledger,
      input: attempt(wrongBranchPacket, "operation:wrong-branch"), clock: () => proofNow,
    });
    assert.equal(wrongBranch.code, "BRANCH_MISMATCH");
    assert.deepEqual(f.store.getWork(f.opened.work.id), before);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a branchless packet rejects as BRANCH_MISMATCH without kernel mutation", () => {
  const f = proofFixture();
  try {
    const beforeWork = f.store.getWork(f.opened.work.id);
    const beforeHistory = f.store.history(f.opened.work.id);
    const branchless = structuredClone(f.current);
    branchless.activeBranch = null;
    branchless.budget.usedBytes = Buffer.byteLength(JSON.stringify(branchless), "utf8");
    const rejected = attemptVerifiedResume({
      store: f.store,
      ledger: f.ledger,
      input: attempt(branchless, "operation:branchless-packet"),
      clock: () => proofNow,
    });
    assert.equal(rejected.code, "BRANCH_MISMATCH");
    assert.equal(rejected.outcome, "rejected");
    assert.deepEqual(f.store.getWork(f.opened.work.id), beforeWork);
    assert.deepEqual(f.store.history(f.opened.work.id), beforeHistory);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("user acceptance is required without mutating kernel state", () => {
  const f = proofFixture();
  try {
    const before = f.store.getWork(f.opened.work.id);
    const rejected = attemptVerifiedResume({
      store: f.store,
      ledger: f.ledger,
      input: { ...attempt(f.current, "operation:acceptance-required"), acceptedByUser: false },
      clock: () => proofNow,
    });
    assert.equal(rejected.code, "USER_ACCEPTANCE_REQUIRED");
    assert.equal(rejected.outcome, "rejected");
    assert.deepEqual(f.store.getWork(f.opened.work.id), before);
    assert.deepEqual(f.ledger.replay(rejected.operationId, rejected.attemptDigest), rejected);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("P07-P09 current resume commits once and operation replay is exact", () => {
  const f = proofFixture();
  try {
    const input = attempt(f.current, "operation:proof-current");
    const beforeHistory = f.store.history(f.opened.work.id).length;
    const accepted = attemptVerifiedResume({ store: f.store, ledger: f.ledger, input, clock: () => proofNow });
    assert.equal(accepted.code, "RESUMED");
    assert.equal(accepted.observedRevisionAfter!, accepted.observedRevisionBefore! + 1);
    assert.equal(f.store.history(f.opened.work.id).length, beforeHistory + 1);
    assert.deepEqual(attemptVerifiedResume({ store: f.store, ledger: f.ledger, input, clock: () => proofNow }), accepted);
    assert.equal(f.store.getWork(f.opened.work.id).revision, accepted.observedRevisionAfter);
    assert.throws(() => attemptVerifiedResume({
      store: f.store, ledger: f.ledger,
      input: { ...input, acceptedByUser: false }, clock: () => proofNow,
    }), OperationConflict);
    assert.equal(f.store.getWork(f.opened.work.id).revision, accepted.observedRevisionAfter);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Candidate B accepted receipt preserves proof-contract-v2 and bounded evidence", () => {
  const f = proofFixture();
  try {
    const accepted = attemptVerifiedResume({
      store: f.store,
      ledger: f.ledger,
      input: attempt(f.current, "operation:proof-current-evidence"),
      clock: () => proofNow,
    });
    assert.equal(accepted.code, "RESUMED");
    assert.ok(accepted.provenance.includes("artifact:proof-contract-v2"));
    assert.deepEqual(accepted.evidence, [...f.current.recentDeltas.map((delta) => delta.id)].sort());
    assert.ok(accepted.provenance.length <= 20);
    assert.ok(accepted.evidence.length <= 20);
    assert.ok([...accepted.provenance, ...accepted.evidence].every((item) => item.length <= 240));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("P10 receipt renderer projects the authoritative JSON fields", () => {
  const output = renderResumeReceipt(receipt({ outcome: "accepted", code: "RESUMED", observedRevisionAfter: 4 }));
  assert.match(output, /ACCEPTED\s+RESUMED/);
  assert.match(output, /expected\s+2/);
  assert.match(output, /observed\s+3 → 4/);
  assert.match(output, /work:proof/);
  assert.match(output, /branch:proof/);
  assert.match(output, /artifact:proof-contract-v1/);
});

test("P11 comparator fixture is bounded and contains no credential or account identifier", () => {
  const file = new URL("./fixtures/comparator/memstate-customer0-2026-09-04.json", import.meta.url);
  const raw = fs.readFileSync(file, "utf8");
  const value = JSON.parse(raw);
  assert.equal(value.schema, "trajecta.comparator-observation/v1");
  assert.equal(value.candidates.length, 2);
  assert.match(value.claim_boundary, /bounded fixture/i);
  assert.doesNotMatch(raw, /mst_|api[_ -]?key|@|pinksilkpham|tamvi-journal/i);
});
