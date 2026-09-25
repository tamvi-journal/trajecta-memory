import crypto from "node:crypto";
import type { TrajectaStore } from "../../store.ts";
import { assertResumeAttempt, digestResumeAttempt, stableSerialize } from "./attempt-contract.ts";
import type { ResumeAttemptCode, ResumeAttemptInputV1, ResumeAttemptReceiptV1 } from "./attempt-contract.ts";
import type { ResumeAttemptLedger } from "./attempt-ledger.ts";

interface AttemptDependencies {
  store: TrajectaStore;
  ledger: ResumeAttemptLedger;
  input: ResumeAttemptInputV1;
  clock?: () => Date;
}

export function inspectVerifiedResume({ store, input }: Pick<AttemptDependencies, "store" | "input">) {
  assertResumeAttempt(input);
  if (input.packet.intendedFor !== "local" || stableSerialize(input.target) !== stableSerialize(input.expectedTarget)) {
    throw new Error("Target capability mismatch");
  }
  const current = store.getWork(input.packet.work.id);
  return {
    schema: "trajecta.resume-inspection/v1" as const,
    workId: current.id,
    packetId: input.packet.packetId,
    branchId: input.packet.activeBranch?.id ?? null,
    activeBranchId: current.activeBranchId,
    expectedRevision: input.packet.resume.expectedRevision,
    currentRevision: current.revision,
    nextAction: input.packet.work.nextAction,
    provenance: [...new Set(input.packet.recentDeltas.flatMap((delta) => delta.provenance))].sort(),
  };
}

export function attemptVerifiedResume({ store, ledger, input, clock = () => new Date() }: AttemptDependencies) {
  assertResumeAttempt(input);
  const attemptDigest = digestResumeAttempt(input);
  const replay = ledger.replay(input.operationId, attemptDigest);
  if (replay) return replay;

  const provenance = [...new Set(input.packet.recentDeltas.flatMap((delta) => delta.provenance))].sort();
  const evidence = [...new Set(input.packet.recentDeltas.map((delta) => delta.id))].sort();
  const makeReceipt = (
    outcome: "rejected" | "accepted",
    code: ResumeAttemptCode,
    before: number | null,
    after: number | null,
  ): ResumeAttemptReceiptV1 => ({
    schema: "trajecta.resume-attempt-receipt/v1",
    receiptId: `receipt:${crypto.randomUUID()}`,
    operationId: input.operationId,
    attemptDigest,
    outcome,
    code,
    workId: input.packet.work.id,
    branchId: input.packet.activeBranch?.id ?? null,
    packetId: input.packet.packetId,
    target: { surface: "local", name: input.target.name, session: input.target.session },
    expectedRevision: input.packet.resume.expectedRevision,
    observedRevisionBefore: before,
    observedRevisionAfter: after,
    provenance,
    evidence,
    createdAt: clock().toISOString(),
  });
  if (input.packet.intendedFor !== "local" || stableSerialize(input.target) !== stableSerialize(input.expectedTarget)) {
    return ledger.commit(makeReceipt("rejected", "TARGET_MISMATCH", null, null));
  }

  const current = store.getWork(input.packet.work.id);
  const reject = (code: Exclude<ResumeAttemptCode, "RESUMED">) =>
    ledger.commit(makeReceipt("rejected", code, current.revision, current.revision));
  if (!input.packet.activeBranch?.id || !current.activeBranchId || input.packet.activeBranch.id !== current.activeBranchId) {
    return reject("BRANCH_MISMATCH");
  }
  if (input.packet.resume.expectedRevision !== current.revision) return reject("REVISION_CONFLICT");
  if (!input.acceptedByUser) return reject("USER_ACCEPTANCE_REQUIRED");

  const resumed = store.resume({
    operationId: input.operationId,
    workId: input.packet.work.id,
    expectedRevision: input.packet.resume.expectedRevision,
    surface: { kind: "local", name: input.target.name, session: input.target.session },
    instruction: input.packet.work.nextAction ?? undefined,
  });
  return ledger.commit(makeReceipt("accepted", "RESUMED", current.revision, resumed.work.revision));
}
