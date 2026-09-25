# Trajecta Verified Resume — Vertical Proof Contract

**Status:** proposed for Ty review  
**Date:** 2026-09-04  
**Owner:** Trajecta Customer-0 / product-validation branch  
**Parent contract:** `docs/specs/2026-09-04-chatgpt-codex-adapter-v1.md`  
**Milestone:** first falsifiable adapter proof, before landing-page revision or external recruitment

## 1. Decision

Build one thin vertical proof before completing the four horizontal adapter
slices in the parent contract. The proof starts with two candidate handoff
packets for one exact work item and ends with two durable attempt receipts:

1. a stale packet is rejected before any work or target state changes;
2. the current packet resumes the exact task and branch once;
3. an equivalent retry returns the committed receipt instead of advancing work
   again.

This proof is the first implementation milestone. It temporarily supersedes the
parent document's horizontal slice order, but it does not weaken or replace any
parent invariant. Production file parsing, canonical-envelope hardening,
30-minute target expiry, cloud return delivery, and polished CLI UX remain
later work.

## 2. Why this proof exists

Customer-0 testing established a useful contrast:

- semantic memory can retain and rank contradictory statements;
- version labels alone do not establish which statement is authorized to
  continue work;
- automatic extraction may place a correction under a different keypath and
  bypass the expected version chain.

Trajecta's claim is smaller and must be mechanically stronger:

> Given one exact work item and branch, only a packet matching the current
> revision may advance the trajectory, and every attempt returns an auditable
> receipt.

The proof is not a claim that semantic memory is defective or unnecessary.
Semantic memory is complementary context. It is not resume authority.

## 3. Product question

Can a skeptical technical user observe, in one reproducible run, that Trajecta
prevents an agent from acting on a plausible but stale next action while still
allowing the verified current packet to resume without duplicate mutation?

The proof passes only if the answer is visible in state, history, and receipt
artifacts—not merely printed by a scripted demo.

## 4. Chosen approach

### Selected: offline deterministic vertical fixture

Use the existing `TrajectaStore`, `TransferPacket`, and revision-CAS behavior.
Add the smallest adapter-level attempt ledger and receipt renderer needed to
make rejection and acceptance inspectable. The fixture runs locally without a
Memstate account, network access, browser state, or secret.

### Rejected for this milestone: finish contract hardening first

Completing canonical JSON, external file parsing, target expiry, workspace
fingerprinting, and every security error before exercising the value path would
delay the falsifiable product proof. Those controls remain mandatory before a
real untrusted file handoff.

### Rejected for this milestone: rebuild the landing-page simulation

The existing page already explains stale rejection. Another simulated UI would
not increase product evidence. The next page revision must consume receipts
from the real fixture.

## 5. Scope

### In scope

- One isolated temporary Trajecta state root.
- One exact work ID and one active branch with a return point.
- A stale candidate and a current candidate derived from real kernel state.
- Read-only inspection before either resume attempt.
- Adapter-level rejected and accepted attempt receipts.
- Revision-CAS rejection before mutation.
- Exact task, branch, target surface, and session checks.
- Idempotent retry of an accepted operation.
- Altered operation-ID reuse rejection.
- Machine-readable JSON artifacts and a concise human-readable trace.
- Tests proving state and receipt invariants.
- A sanitized comparator observation fixture derived from the authenticated
  Customer-0 test, clearly labeled as an observation rather than a dependency.

### Out of scope

- Calling Memstate or any external service from tests or product runtime.
- General semantic memory, transcript ingestion, or automatic fact extraction.
- Production-ready untrusted JSON parsing and canonical envelope integrity.
- Long-lived secrets, OAuth, hosted relay, billing, analytics, or team sync.
- Automatic discovery by current window, latest task, title, or repository name.
- Executing packet instructions or shell commands.
- ChatGPT or Codex UI automation.
- Landing-page redesign, marketing publication, or competitor claims.
- Cloud-return outcome delivery; the proof ends at verified local resume.

## 6. Fixture state

The fixture creates one work item with stable, non-random semantic values:

```text
work:      work:<opaque-generated-id>
topic:     Adapter Slice 1 proof
branch:    branch:<opaque-generated-id> / verified-resume-proof
surface:   cloud:planning-fixture
revision:  N
next:      Implement the verified adapter proof
provenance artifact:proof-contract-v1
return:    Compare the accepted receipt with the stale rejection receipt
```

The test may normalize generated IDs into stable redaction tokens only when producing a
golden display fixture. Runtime validation always uses the real opaque IDs.

### Candidate A — stale

Candidate A is a genuine packet captured at revision `N`. The fixture then
records one material current-state delta, advancing the work to `N+1`. Candidate
A remains byte-for-byte unchanged and therefore carries
`resume.expectedRevision = N`.

Its content must remain plausible. It is stale because its revision is old, not
because it contains cartoonishly bad text.

### Candidate B — current

Candidate B is exported after the material delta and carries
`resume.expectedRevision = N+1`. It references the same exact work ID and active
branch and includes the updated next action and provenance.

## 7. Attempt contract

The adapter exposes one proof-only boundary:

```ts
interface ResumeAttemptInputV1 {
  schema: "trajecta.resume-attempt/v1";
  operationId: string;
  packet: TransferPacket;
  target: {
    surface: "local";
    name: string;
    session: string;
    capability: string;
  };
  expectedTarget: {
    surface: "local";
    name: string;
    session: string;
    capability: string;
  };
  acceptedByUser: boolean;
}
```

The adapter validates, in order:

1. supported attempt and packet schemas and bounded fields;
2. deterministic normalization and attempt digest;
3. operation-ledger lookup: return an equivalent resolved replay or reject
   altered operation-ID reuse;
4. exact local target surface;
5. byte-equal expected target descriptor, including opaque session capability;
6. exact work ID exists;
7. packet branch equals the work's active branch;
8. packet expected revision equals the current revision;
9. explicit fixture acceptance is true;
10. kernel resume commits once;
11. receipt commits after the resolved kernel result.

No failed check may call `TrajectaStore.resume()`.

The proof digest uses a fixed recursive key sort over the typed in-memory
attempt object followed by SHA-256. This is sufficient for deterministic
idempotency inside the offline fixture; it is not the production untrusted-JSON
canonicalization contract defined by the parent adapter specification.

## 8. Receipt contract

Every resolved attempt writes one append-only JSON receipt:

```ts
interface ResumeAttemptReceiptV1 {
  schema: "trajecta.resume-attempt-receipt/v1";
  receiptId: string;
  operationId: string;
  attemptDigest: string;
  outcome: "rejected" | "accepted";
  code: "REVISION_CONFLICT" | "TARGET_MISMATCH" | "BRANCH_MISMATCH"
      | "USER_ACCEPTANCE_REQUIRED" | "RESUMED";
  workId: string;
  branchId: string | null;
  packetId: string;
  target: {
    surface: "local";
    name: string;
    session: string;
  };
  expectedRevision: number;
  observedRevisionBefore: number | null;
  observedRevisionAfter: number | null;
  provenance: string[];
  evidence: string[];
  createdAt: string;
}
```

### Receipt semantics

- `rejected` is evidence that the named invariant failed; it is not a transport
  or resume success.
- A target/capability rejection occurs before live work lookup and records null
  observed revisions; it must not leak current work state to an unbound target.
- A revision rejection records the packet's expected revision and the current
  observed revision, with equal before/after revisions.
- `accepted` requires a committed kernel resume and reports exactly one revision
  advance.
- The receipt copies only bounded provenance already present in the packet plus
  proof-generated test evidence. It never upgrades an arbitrary string into
  verification.
- Receipt IDs and timestamps may differ between independent fixture runs;
  semantic fields must remain deterministic.

## 9. Durable attempt ledger

The proof adds an adapter-owned append-only ledger separate from kernel state.
Each record contains the operation ID, digest of the normalized attempt input,
resolution, and final receipt.

Rules:

- An unseen operation ID may begin one attempt.
- An equivalent retry of a committed accepted attempt returns the stored
  receipt byte-for-byte and does not call the kernel again.
- Reusing an operation ID with a different digest throws the bounded
  `OperationConflict` error and does not mutate kernel or ledger history. It
  does not append a second receipt under the already-owned operation ID; the
  original receipt remains the single durable authority for that operation.
- A rejected revision attempt is durably recorded. Repeating the exact rejected
  input returns the same rejection receipt; it does not re-evaluate against a
  later state and silently change meaning.
- Atomic crash recovery is not claimed by this proof. A reserved-but-unresolved
  operation must surface as `inspection-required` in the later production
  adapter, as required by the parent contract.

## 10. Rejection invariants

For Candidate A at revision `N` when current state is `N+1`:

- result code is `REVISION_CONFLICT`;
- `observedRevisionBefore === observedRevisionAfter === N+1`;
- active branch is unchanged;
- work status, instruction, open loops, next action, and last surface are
  unchanged;
- kernel history length is unchanged;
- no resume delta is appended;
- no `target-resumed` claim is emitted;
- the target capability remains usable by Candidate B;
- a durable rejection receipt exists.

An exception message without these state assertions is insufficient evidence.

## 11. Acceptance invariants

For Candidate B at revision `N+1`:

- the exact work ID and branch are resumed on the named local session;
- result code is `RESUMED`;
- revision advances once to `N+2`;
- exactly one resume delta is appended;
- the work's last surface becomes the exact local target;
- receipt provenance includes Candidate B's material source evidence;
- an equivalent retry returns the same receipt and leaves revision at `N+2`;
- altered reuse of the accepted operation ID fails without mutation.

## 12. Comparator fixture

Store a small sanitized JSON observation under the test fixtures. It may contain
only the behavior necessary to explain the market contrast:

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

The comparator fixture is documentation evidence only. Tests must not assert
that another product is wrong. They assert that Trajecta cannot produce two
accepted heads for one exact work/branch transition.

## 13. Human-readable proof trace

One command eventually renders this sequence from real fixture results:

```text
CURRENT   work:<id> / branch:<id> / revision N+1

ATTEMPT A packet:<stale> expected N
REJECTED  REVISION_CONFLICT observed N+1 → N+1
RECEIPT   receipt:<id> provenance artifact:proof-contract-v1

ATTEMPT B packet:<current> expected N+1
ACCEPTED  RESUMED observed N+1 → N+2
RECEIPT   receipt:<id> provenance artifact:proof-contract-v2

RETRY B   same operation → same receipt / revision remains N+2
```

The trace is a projection of JSON artifacts. It is never the sole source of
truth.

## 14. Acceptance matrix

| ID | Requirement | Authoritative evidence |
|---|---|---|
| P01 | Fixture creates one exact work and active branch | Kernel state + open delta |
| P02 | Inspection does not mutate state | Before/after state and history digest |
| P03 | Stale packet is rejected | Rejection receipt with `REVISION_CONFLICT` |
| P04 | Rejection advances nothing | Equal revision, state, and history assertions |
| P05 | Wrong target/session fails closed | Target rejection test and receipt |
| P06 | Wrong branch fails closed | Branch rejection test and receipt |
| P07 | Current packet resumes once | Accepted receipt + one resume delta |
| P08 | Equivalent accepted retry is idempotent | Same receipt and unchanged `N+2` state |
| P09 | Altered operation reuse fails | `OPERATION_CONFLICT` with no mutation |
| P10 | Receipt provenance is bounded and preserved | Golden semantic receipt assertion |
| P11 | Comparator evidence contains no secret/account identifier | Fixture content audit |
| P12 | Clean checkout reproduces the full trace | `npm run check` in an isolated copy |

## 15. Proposed implementation boundary

The later implementation plan should prefer these focused units:

```text
src/adapters/proof/
  attempt-contract.ts     # types and bounded validation
  attempt-ledger.ts       # append-only idempotency records
  attempt-resume.ts       # validation order and kernel call boundary
  receipt-renderer.ts     # JSON-to-text projection only
test/adapter-proof.test.ts
test/fixtures/comparator/memstate-customer0-2026-09-04.json
examples/verified-resume-proof.ts
```

The kernel must not import adapter proof modules. The proof adapter may depend
on the public kernel API.

## 16. Verification commands and clean-room rule

The implementation plan must integrate the proof into existing repository
verification:

```text
npm test
npm run demo
npm run check
```

`npm run check` must exercise the real stale/current proof, not merely the
landing-page state machine. A second run from an isolated checkout or copied
source tree must produce the same semantic outcomes without browser login,
network access, or pre-existing `.trajecta` state.

Generated fixture artifacts go to a temporary directory by default. Checked-in
goldens must be sanitized and deterministic.

## 17. Stop conditions

Stop implementation and return to design if any of these becomes necessary:

- changing kernel revision-CAS semantics;
- resolving a target by UI title, latest/current task, or frontmost window;
- treating packet instructions as executable authority;
- adding a network service or secret to make the offline proof pass;
- weakening rejected-state assertions because the receipt layer cannot model
  them;
- presenting comparator observations as a universal benchmark;
- expanding the milestone into the full production adapter or a new dashboard.

## 18. Definition of done

The proof milestone is done only when:

1. P01–P12 pass in automated tests;
2. existing kernel, relay, and site tests remain green;
3. the stale attempt produces a durable rejection receipt and zero mutation;
4. the current attempt advances exactly once and retry is idempotent;
5. the human trace is rendered from the same JSON receipts the tests inspect;
6. a clean-room run reproduces the semantic trace;
7. no runtime dependency on Memstate, ChatGPT UI, Codex UI, Lam Controller, or
   another external service exists;
8. public copy remains unchanged until the proof artifacts have been reviewed.

## 19. Exact next action after approval

Write an implementation plan for this contract only. Begin with failing tests
for P03, P04, P07, P08, and P09; then add the smallest attempt ledger and resume
boundary required to pass them. Do not redesign the site or implement the full
production file adapter in the same plan.
