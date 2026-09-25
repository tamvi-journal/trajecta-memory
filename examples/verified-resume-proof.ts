import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ResumeAttemptLedger,
  TrajectaStore,
  attemptVerifiedResume,
  renderResumeReceipt,
} from "../src/index.ts";
import type { ResumeAttemptInputV1, Surface } from "../src/index.ts";

const suppliedRoot = process.env.TRAJECTA_PROOF_ROOT;
const root = suppliedRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-verified-proof-"));
const ownsRoot = suppliedRoot === undefined;
const now = new Date("2026-09-04T00:00:00.000Z");
const cloud: Surface = { kind: "cloud", name: "ChatGPT fixture", session: "cloud:proof" };
const target = {
  surface: "local" as const,
  name: "Codex fixture",
  session: "local:proof",
  capability: "capability:codex-proof",
};

try {
  const store = new TrajectaStore(root, () => now);
  const ledger = new ResumeAttemptLedger(root);
  const opened = store.open({
    operationId: "operation:example-open",
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
    operationId: "operation:example-handoff-v1",
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
    operationId: "operation:example-decision-v2",
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
  const makeAttempt = (packet: typeof stale, operationId: string): ResumeAttemptInputV1 => ({
    schema: "trajecta.resume-attempt/v1",
    operationId,
    packet,
    target,
    expectedTarget: target,
    acceptedByUser: true,
  });

  const rejected = attemptVerifiedResume({
    store, ledger, input: makeAttempt(stale, "operation:example-stale"), clock: () => now,
  });
  const acceptedInput = makeAttempt(current, "operation:example-current");
  const accepted = attemptVerifiedResume({ store, ledger, input: acceptedInput, clock: () => now });
  const replayed = attemptVerifiedResume({ store, ledger, input: acceptedInput, clock: () => now });

  assert.equal(rejected.code, "REVISION_CONFLICT");
  assert.equal(rejected.observedRevisionBefore, rejected.observedRevisionAfter);
  assert.equal(accepted.code, "RESUMED");
  assert.equal(accepted.observedRevisionAfter!, accepted.observedRevisionBefore! + 1);
  assert.deepEqual(replayed, accepted);
  assert.equal(store.getWork(opened.work.id).revision, accepted.observedRevisionAfter);

  console.log(`CURRENT   ${opened.work.id} / ${revised.work.activeBranchId} / revision ${revised.work.revision}`);
  console.log(`\nATTEMPT A ${stale.packetId} expected ${stale.resume.expectedRevision}`);
  console.log(renderResumeReceipt(rejected));
  console.log(`\nATTEMPT B ${current.packetId} expected ${current.resume.expectedRevision}`);
  console.log(renderResumeReceipt(accepted));
  console.log(`\nRETRY B   same receipt / revision remains ${store.getWork(opened.work.id).revision}`);
} finally {
  if (ownsRoot) fs.rmSync(root, { recursive: true, force: true });
}
