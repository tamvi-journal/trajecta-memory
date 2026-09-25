# Trajecta Verified Resume Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one offline, reproducible proof that rejects a stale handoff with zero mutation, resumes the exact current task and branch once, and emits durable provenance-bearing attempt receipts.

**Architecture:** Add a proof adapter above the existing transport-neutral `TrajectaStore`. A deterministic attempt contract feeds an append-only adapter ledger; the resume boundary resolves idempotent replay before inspecting live state, writes durable rejection receipts for failed invariants, and delegates the sole accepted mutation to the kernel's revision-CAS `resume()`. A local example renders its trace from the same JSON receipts asserted by tests.

**Tech Stack:** Node.js 22.19+, TypeScript executed with Node type stripping, `node:test`, built-in `crypto`/`fs`/`path`, existing file-backed Trajecta kernel; no new runtime dependency.

**Spec:** `docs/specs/2026-09-04-trajecta-stale-resume-proof-contract.md`

## Global Constraints

- The proof is offline: no Memstate, ChatGPT UI, Codex UI, browser, network, API key, OAuth, hosted relay, billing, or Lam Controller dependency.
- Current user input and workspace state outrank transferred context.
- One attempt targets one exact work ID, active branch, local surface, and opaque session capability.
- Operation-ledger replay/conflict resolution occurs before live revision validation.
- No failed validation may call `TrajectaStore.resume()`.
- A stale rejection must preserve revision, state, history, and target capability.
- An accepted attempt advances revision exactly once; byte-equivalent retry returns the stored receipt.
- Comparator data is sanitized observation evidence, never executable input or a universal competitor claim.
- The kernel must not import adapter modules; the adapter may depend on the public kernel API.
- Public landing-page copy remains unchanged during this plan.
- Preserve the existing untracked research/business documents; stage only files named by each task.

## File Map

| File | Responsibility |
|---|---|
| `src/adapters/proof/attempt-contract.ts` | Attempt/receipt types, bounded validation, recursive-key canonicalization, SHA-256 digest |
| `src/adapters/proof/attempt-ledger.ts` | Append-only resolved-attempt records and operation replay/conflict lookup |
| `src/adapters/proof/attempt-resume.ts` | Ordered target/branch/revision/acceptance validation and the single kernel mutation boundary |
| `src/adapters/proof/receipt-renderer.ts` | Pure JSON-receipt-to-text projection |
| `src/index.ts` | Public proof-adapter exports without reversing the dependency direction |
| `test/adapter-proof.test.ts` | P01–P10 behavioral and state-invariant tests |
| `test/fixtures/comparator/memstate-customer0-2026-09-04.json` | Sanitized bounded comparator observation for P11 |
| `examples/verified-resume-proof.ts` | Real stale/current fixture and receipt-derived trace |
| `test/proof-clean-room.test.ts` | Two isolated process runs for P12 |
| `package.json` | `proof` command and integration into `check` |

---

### Task 1: Attempt contract and deterministic digest

**Files:**
- Create: `src/adapters/proof/attempt-contract.ts`
- Create: `test/adapter-proof.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `TransferPacket` and `Surface` from `src/types.ts`.
- Produces: `ResumeAttemptInputV1`, `ResumeAttemptReceiptV1`, `ResumeAttemptCode`, `assertResumeAttempt()`, `stableSerialize()`, and `digestResumeAttempt()`.

- [ ] **Step 1: Write failing contract and digest tests**

Add these imports and tests to `test/adapter-proof.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertResumeAttempt,
  digestResumeAttempt,
  stableSerialize,
} from "../src/index.ts";

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
```

- [ ] **Step 2: Run the focused tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/adapter-proof.test.ts
```

Expected: FAIL because the proof-contract exports do not exist.

- [ ] **Step 3: Implement exact proof types and stable serialization**

Create `src/adapters/proof/attempt-contract.ts` with these public shapes and behavior:

```ts
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

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
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

function bounded(value: string, label: string, max: number) {
  if (!value?.trim() || value.length > max) throw new Error(`${label} is required and must not exceed ${max} characters`);
}

export function assertResumeAttempt(input: ResumeAttemptInputV1) {
  if (input?.schema !== "trajecta.resume-attempt/v1") throw new Error("Unsupported resume attempt schema");
  if (input.packet?.schema !== "trajecta.transfer/v1") throw new Error("Unsupported transfer packet schema");
  bounded(input.operationId, "Operation ID", 240);
  if (!/^[a-z]+:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.operationId)) throw new Error("Operation ID must be namespaced");
  bounded(input.target?.name, "Target name", 120);
  bounded(input.target?.session, "Target session", 200);
  bounded(input.target?.capability, "Target capability", 240);
  bounded(input.expectedTarget?.name, "Expected target name", 120);
  bounded(input.expectedTarget?.session, "Expected target session", 200);
  bounded(input.expectedTarget?.capability, "Expected target capability", 240);
  if (input.target.surface !== "local" || input.expectedTarget.surface !== "local") throw new Error("Proof target must be local");
  if (typeof input.acceptedByUser !== "boolean") throw new Error("acceptedByUser must be boolean");
  stableSerialize(input);
}
```

Export the new values and types from `src/index.ts`:

```ts
export { assertResumeAttempt, digestResumeAttempt, stableSerialize } from "./adapters/proof/attempt-contract.ts";
export type { ResumeAttemptCode, ResumeAttemptInputV1, ResumeAttemptReceiptV1, ResumeTargetV1 } from "./adapters/proof/attempt-contract.ts";
```

- [ ] **Step 4: Run focused and existing tests**

Run:

```bash
node --experimental-strip-types --test test/adapter-proof.test.ts test/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/adapters/proof/attempt-contract.ts src/index.ts test/adapter-proof.test.ts
git commit -m "feat: define verified resume attempt contract"
```

---

### Task 2: Append-only attempt ledger and replay authority

**Files:**
- Create: `src/adapters/proof/attempt-ledger.ts`
- Modify: `src/index.ts`
- Modify: `test/adapter-proof.test.ts`

**Interfaces:**
- Consumes: `ResumeAttemptReceiptV1` and the existing `OperationConflict` error.
- Produces: `ResumeAttemptLedger`, with `replay(operationId, digest)`, `commit(receipt)`, and `history()`.

- [ ] **Step 1: Write failing ledger tests**

Append:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperationConflict, ResumeAttemptLedger } from "../src/index.ts";
import type { ResumeAttemptReceiptV1 } from "../src/index.ts";

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
```

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
node --experimental-strip-types --test test/adapter-proof.test.ts
```

Expected: FAIL because `ResumeAttemptLedger` is not exported.

- [ ] **Step 3: Implement the ledger**

Create `src/adapters/proof/attempt-ledger.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { OperationConflict } from "../../store.ts";
import type { ResumeAttemptReceiptV1 } from "./attempt-contract.ts";

interface AttemptRecordV1 {
  schema: "trajecta.resume-attempt-record/v1";
  operationId: string;
  attemptDigest: string;
  receipt: ResumeAttemptReceiptV1;
}

export class ResumeAttemptLedger {
  private readonly file: string;
  constructor(root: string) { this.file = path.join(root, "proof-attempts.jsonl"); }

  history(): AttemptRecordV1[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as AttemptRecordV1);
  }

  replay(operationId: string, attemptDigest: string): ResumeAttemptReceiptV1 | null {
    const matches = this.history().filter((record) => record.operationId === operationId);
    if (!matches.length) return null;
    if (matches.some((record) => record.attemptDigest !== attemptDigest)) throw new OperationConflict();
    return structuredClone(matches.at(-1)!.receipt);
  }

  commit(receipt: ResumeAttemptReceiptV1): ResumeAttemptReceiptV1 {
    const replay = this.replay(receipt.operationId, receipt.attemptDigest);
    if (replay) return replay;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const record: AttemptRecordV1 = {
      schema: "trajecta.resume-attempt-record/v1",
      operationId: receipt.operationId,
      attemptDigest: receipt.attemptDigest,
      receipt: structuredClone(receipt),
    };
    fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return structuredClone(receipt);
  }
}
```

Export `ResumeAttemptLedger` from `src/index.ts`.

- [ ] **Step 4: Run focused tests**

```bash
node --experimental-strip-types --test test/adapter-proof.test.ts
```

Expected: PASS, with one physical ledger record after equivalent replay.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/adapters/proof/attempt-ledger.ts src/index.ts test/adapter-proof.test.ts
git commit -m "feat: persist resume attempt receipts"
```

---

### Task 3: Ordered resume boundary and zero-mutation rejection

**Files:**
- Create: `src/adapters/proof/attempt-resume.ts`
- Modify: `src/index.ts`
- Modify: `test/adapter-proof.test.ts`

**Interfaces:**
- Consumes: `TrajectaStore`, `ResumeAttemptLedger`, `ResumeAttemptInputV1`, `digestResumeAttempt()`, and a deterministic clock.
- Produces: read-only `inspectVerifiedResume({ store, input })` and mutating `attemptVerifiedResume({ store, ledger, input, clock }) -> ResumeAttemptReceiptV1`.

- [ ] **Step 1: Add one reusable stale/current test fixture**

Append a `proofFixture()` helper that:

```ts
import { TrajectaStore, attemptVerifiedResume, inspectVerifiedResume } from "../src/index.ts";
import type { ResumeAttemptInputV1, Surface } from "../src/index.ts";

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
```

- [ ] **Step 2: Write failing P01–P09 tests**

Add explicit tests with these assertions:

```ts
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
    const wrongBranch = attemptVerifiedResume({
      store: f.store, ledger: f.ledger,
      input: attempt(wrongBranchPacket, "operation:wrong-branch"), clock: () => proofNow,
    });
    assert.equal(wrongBranch.code, "BRANCH_MISMATCH");
    assert.deepEqual(f.store.getWork(f.opened.work.id), before);
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
```

- [ ] **Step 3: Run focused tests and verify red**

```bash
node --experimental-strip-types --test test/adapter-proof.test.ts
```

Expected: FAIL because `attemptVerifiedResume()` does not exist.

- [ ] **Step 4: Implement ordered validation and receipt creation**

Create `src/adapters/proof/attempt-resume.ts`. Start with the imports and shared
dependency boundary:

```ts
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
```

Continue the same file with the read-only projection:

```ts
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
```

Then continue the same file with the mutating boundary:

```ts
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
  if ((input.packet.activeBranch?.id ?? null) !== current.activeBranchId) return reject("BRANCH_MISMATCH");
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
```

Export `attemptVerifiedResume` and `inspectVerifiedResume` from `src/index.ts`.

- [ ] **Step 5: Run proof and regression tests**

```bash
node --experimental-strip-types --test test/adapter-proof.test.ts test/store.test.ts
```

Expected: PASS. Confirm stale failure appends no kernel delta and accepted retry
leaves the accepted revision unchanged.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/adapters/proof/attempt-resume.ts src/index.ts test/adapter-proof.test.ts
git commit -m "feat: reject stale resume attempts with receipts"
```

---

### Task 4: Sanitized comparator and receipt-derived proof trace

**Files:**
- Create: `src/adapters/proof/receipt-renderer.ts`
- Create: `test/fixtures/comparator/memstate-customer0-2026-09-04.json`
- Create: `examples/verified-resume-proof.ts`
- Modify: `src/index.ts`
- Modify: `test/adapter-proof.test.ts`

**Interfaces:**
- Consumes: accepted/rejected `ResumeAttemptReceiptV1` objects and the Task 3 fixture pattern.
- Produces: `renderResumeReceipt(receipt)` and a real example trace.

- [ ] **Step 1: Add the bounded comparator fixture**

Create the JSON exactly as approved by the spec:

```json
{
  "schema": "trajecta.comparator-observation/v1",
  "source": "authenticated-customer0-observation",
  "observed_on": "2026-09-04",
  "query": "Should the team launch paid ads now?",
  "candidates": [
    { "summary": "launch_paid_ads_immediately", "is_latest": true, "rank": 1 },
    { "summary": "do_not_buy_paid_ads_before_proof", "is_latest": true, "rank": 2 }
  ],
  "claim_boundary": "One bounded fixture; not a claim about every competitor workflow."
}
```

- [ ] **Step 2: Write failing P10–P11 renderer and sanitization tests**

```ts
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
```

- [ ] **Step 3: Run tests and verify red**

```bash
node --experimental-strip-types --test test/adapter-proof.test.ts
```

Expected: FAIL because `renderResumeReceipt()` does not exist.

- [ ] **Step 4: Implement the pure renderer**

Create `src/adapters/proof/receipt-renderer.ts`:

```ts
import type { ResumeAttemptReceiptV1 } from "./attempt-contract.ts";

export function renderResumeReceipt(receipt: ResumeAttemptReceiptV1) {
  const heading = receipt.outcome === "accepted" ? "ACCEPTED" : "REJECTED";
  return [
    `${heading}  ${receipt.code}`,
    `work      ${receipt.workId}`,
    `branch    ${receipt.branchId ?? "none"}`,
    `packet    ${receipt.packetId}`,
    `expected  ${receipt.expectedRevision}`,
    `observed  ${receipt.observedRevisionBefore} → ${receipt.observedRevisionAfter}`,
    `target    ${receipt.target.surface}:${receipt.target.name}/${receipt.target.session}`,
    `receipt   ${receipt.receiptId}`,
    `provenance ${receipt.provenance.join(" · ") || "none"}`,
    `evidence   ${receipt.evidence.join(" · ") || "none"}`,
  ].join("\n");
}
```

Export `renderResumeReceipt` from `src/index.ts`.

- [ ] **Step 5: Create the real example from kernel state**

Create `examples/verified-resume-proof.ts` using the same fixture construction
as `proofFixture()`. It must:

1. create and own one OS temporary state root;
2. create stale packet at `N`, advance work to `N+1`, then create current packet;
3. call `attemptVerifiedResume()` for stale and current candidates;
4. replay the accepted attempt once;
5. print `CURRENT`, `ATTEMPT A`, both rendered receipts, and
   `RETRY B same receipt / revision remains <N+2>`;
6. clean up only a root it created itself.

Use this complete initial implementation; Task 5 will add caller-owned root
support without changing the scenario:

```ts
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-verified-proof-"));
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
  fs.rmSync(root, { recursive: true, force: true });
}
```

- [ ] **Step 6: Run tests and the example**

```bash
node --experimental-strip-types --test test/adapter-proof.test.ts
node --experimental-strip-types examples/verified-resume-proof.ts
```

Expected: tests PASS; trace visibly contains one `REJECTED REVISION_CONFLICT`,
one `ACCEPTED RESUMED`, and one same-receipt retry.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/adapters/proof/receipt-renderer.ts src/index.ts test/adapter-proof.test.ts test/fixtures/comparator/memstate-customer0-2026-09-04.json examples/verified-resume-proof.ts
git commit -m "feat: render the verified resume proof"
```

---

### Task 5: Clean-room reproduction and repository acceptance gate

**Files:**
- Create: `test/proof-clean-room.test.ts`
- Modify: `examples/verified-resume-proof.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `examples/verified-resume-proof.ts` as a standalone process.
- Produces: `npm run proof` and an expanded `npm run check` that executes the real proof.

- [ ] **Step 1: Write the failing P12 clean-room process test**

Create `test/proof-clean-room.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const example = new URL("../examples/verified-resume-proof.ts", import.meta.url).pathname;

function runIsolated() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-proof-clean-"));
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", example], {
      cwd: root,
      env: { ...process.env, TRAJECTA_PROOF_ROOT: path.join(root, ".trajecta") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, ".trajecta", "state.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".trajecta", "proof-attempts.jsonl")), true);
    assert.match(result.stdout, /REJECTED\s+REVISION_CONFLICT/);
    assert.match(result.stdout, /ACCEPTED\s+RESUMED/);
    assert.match(result.stdout, /same receipt \/ revision remains/);
    assert.doesNotMatch(result.stdout, /mst_|api[_ -]?key|pinksilkpham/i);
    return result.stdout
      .replace(/(?:work|branch|packet|receipt|delta):[A-Za-z0-9._-]+/g, "$ID")
      .replace(/2026-[^\s]+/g, "$TIME");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("P12 two clean roots reproduce the same semantic proof", () => {
  assert.equal(runIsolated(), runIsolated());
});
```

- [ ] **Step 2: Run the clean-room test and verify red**

```bash
node --experimental-strip-types --test test/proof-clean-room.test.ts
```

Expected: FAIL because the example ignores `TRAJECTA_PROOF_ROOT`, so the
caller-provided clean root contains no proof ledger or state.

- [ ] **Step 3: Add explicit caller-owned root support to the example**

At the top of `examples/verified-resume-proof.ts`, choose root ownership
explicitly:

```ts
const suppliedRoot = process.env.TRAJECTA_PROOF_ROOT;
const root = suppliedRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-verified-proof-"));
const ownsRoot = suppliedRoot === undefined;
```

Clean up only when `ownsRoot` is true. Leave a caller-owned root intact so the
clean-room test can inspect its state and ledger after process exit. Do not
replace opaque runtime IDs with fixed IDs inside kernel state.

- [ ] **Step 4: Add proof scripts to `package.json`**

Set the scripts to:

```json
{
  "test": "node --experimental-strip-types --test test/*.test.ts",
  "demo": "node --experimental-strip-types examples/cloud-local-relay.ts",
  "proof": "node --experimental-strip-types examples/verified-resume-proof.ts",
  "check": "npm test && npm run demo && npm run proof"
}
```

- [ ] **Step 5: Run the complete acceptance suite**

```bash
npm run check
git diff --check
```

Expected:

- all existing kernel/site tests pass;
- P01–P12 pass;
- legacy cloud → local → cloud demo still prints revisions 1–4;
- real proof prints stale rejection, exact accepted resume, and same-receipt retry;
- `git diff --check` has no output.

- [ ] **Step 6: Audit the actual changed files against scope**

```bash
git status --short
git diff -- src/adapters/proof src/index.ts test/adapter-proof.test.ts test/proof-clean-room.test.ts test/fixtures/comparator/memstate-customer0-2026-09-04.json examples/verified-resume-proof.ts package.json
```

Confirm there is no change to `index.html`, `styles.css`, `demo.js`, kernel
revision semantics, or the three pre-existing untracked research/business
documents.

- [ ] **Step 7: Commit Task 5**

```bash
git add package.json test/proof-clean-room.test.ts examples/verified-resume-proof.ts
git commit -m "test: reproduce verified resume proof cleanly"
```

## Requirement Coverage

| Spec gate | Plan task |
|---|---|
| P01 exact work and active branch | Task 3 fixture |
| P02 read-only inspection | Task 3 before/after assertions |
| P03 stale rejection receipt | Task 3 stale test |
| P04 rejection advances nothing | Task 3 state/history equality |
| P05 wrong target/session | Task 3 mismatch test |
| P06 wrong branch | Task 3 mismatch test |
| P07 current packet resumes once | Task 3 accepted test |
| P08 equivalent retry | Tasks 2–3 ledger/replay tests |
| P09 altered operation reuse | Tasks 2–3 conflict tests |
| P10 bounded provenance receipt | Tasks 3–4 JSON and renderer assertions |
| P11 sanitized comparator | Task 4 fixture audit |
| P12 isolated reproduction | Task 5 process test and `npm run check` |

## Completion Receipt

Implementation is complete only after the executor reports:

- the commit IDs for Tasks 1–5;
- the exact total/pass/fail count from the final `npm run check`;
- one stale rejection receipt ID and one accepted resume receipt ID from the
  final proof run;
- confirmation that accepted retry returned the same receipt and revision;
- confirmation that landing-page files and pre-existing untracked documents
  were not modified;
- an LWM outcome checkpoint whose provenance names the spec, plan, commits,
  test receipt, and clean-room receipt.
