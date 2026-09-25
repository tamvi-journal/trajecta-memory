<div align="center">
  <img src="assets/mark.svg" width="92" alt="Trajecta mark" />

  # Trajecta

  **Keep the work. Skip the handoff.**

  Cue-first work continuity for cloud chatbots and local agents.<br>
  Preserve the trajectory, not the transcript.

  [![Node 22.19+](https://img.shields.io/badge/node-22.19%2B-4FD1C5?style=for-the-badge&logo=nodedotjs&logoColor=0B1020)](#quick-start)
  [![Status: Alpha](https://img.shields.io/badge/status-alpha-FF6B5E?style=for-the-badge)](#project-status)
  [![Zero dependencies](https://img.shields.io/badge/runtime-zero_dependencies-D6A85F?style=for-the-badge)](#architecture)
  [![Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-F4EFE6?style=for-the-badge)](LICENSE)
</div>

<img src="assets/trajectory-map.svg" width="100%" alt="A work trajectory moving between cloud planning and local implementation, with branches, an anchor, and a next action" />

## The missing bridge

A cloud chatbot is good at conversation, synthesis, and planning. A local agent
can inspect the workspace, run tools, implement, and verify. Today the human in
the middle still has to rewrite the handoff.

Trajecta gives both ends one shared, bounded work trajectory:

```text
cloud chatbot                         local agent
research · discuss · plan             inspect · build · test
       │                                      │
       └────── cue-selected packet ──────────▶│
       │◀──── verified outcome + next action ─┘
```

It records **material deltas**, routes by stable cues, and renders a small
transfer packet for the exact work item. The receiving surface resumes with a
revision guard instead of guessing from a title, a transcript, or “the latest
task.”

> Trajecta began with a boring problem: every capable agent still needed a
> human to rewrite the handoff.

## What it preserves

<table>
  <tr>
    <td width="25%" valign="top"><h3>↗ Deltas</h3>Goals, decisions, blockers, corrections, outcomes, and next actions—not raw transcripts.</td>
    <td width="25%" valign="top"><h3>⌁ Cues</h3>A compact index first. Exact work bodies load only after a cue selects them.</td>
    <td width="25%" valign="top"><h3>⑂ Branches</h3>Explore, park, return, and synthesize without flattening abandoned attempts.</td>
    <td width="25%" valign="top"><h3>⇄ Transfer</h3>Cloud-to-local and local-to-cloud packets carry provenance and an exact resume revision.</td>
  </tr>
</table>

## Quick start

Trajecta is dependency-free TypeScript running directly on Node 22.19+.

```bash
git clone https://github.com/tamvi-journal/trajecta-memory.git
cd trajecta-memory
npm test
npm run demo
```

## Product page

Preview the static product page locally:

```bash
python3 -m http.server 4173
```

Then open [http://localhost:4173/](http://localhost:4173/). The interactive handoff is an explanatory simulation of tested alpha behavior; adapters remain in validation.

```ts
import { TrajectaRelay, TrajectaStore } from "trajecta-memory";

const memory = new TrajectaStore(".trajecta");
const cloud = { kind: "cloud", name: "ChatGPT", session: "cloud:planning" } as const;
const local = { kind: "local", name: "Codex", session: "local:workspace" } as const;

const opened = memory.open({
  operationId: "operation:launch-v1",
  topic: "Launch the first slice",
  goal: "Plan in cloud, build locally, review in cloud",
  surface: cloud,
  initialBranch: {
    label: "first-slice",
    purpose: "Build the smallest verified slice",
    cues: ["launch", "first slice"],
    returnPoint: "Return to cloud after local tests pass",
  },
});

const cloudRelay = new TrajectaRelay(memory, cloud);
const localRelay = new TrajectaRelay(memory, local);

const handoff = cloudRelay.handoff({
  operationId: "operation:plan-ready-v1",
  workId: opened.work.id,
  expectedRevision: opened.work.revision,
  summary: "The plan and acceptance criteria are ready.",
  provenance: ["artifact:plan-v1"],
  openLoops: ["Implement", "Test"],
  nextAction: "Build locally",
  target: "local",
  cue: "build first slice",
});

localRelay.accept(handoff.packet, "operation:local-resume-v1");
```

The full round trip is in
[`examples/cloud-local-relay.ts`](examples/cloud-local-relay.ts).

## Architecture

```text
material event
      │
      ▼
append-only delta log ───────────────┐
      │                              │
      ▼                              ▼
atomic work projection       contract history
      │                              │
      └──── cue router ──────────────┘
                    │
                    ▼
          bounded transfer packet
                    │
             revision-CAS resume
```

- **Append-only history:** mistakes and previous contracts remain inspectable.
- **Mutable projection:** the current work view is rebuildable from durable deltas.
- **Cue-first loading:** routing does not bulk-load every active task.
- **Bounded packets:** a hard UTF-8 byte budget prevents accidental context floods.
- **Exact continuation:** opaque work IDs and compare-and-swap revisions prevent stale writers from overwriting newer work.
- **Transport-neutral core:** adapters decide how a packet moves between products.

The alpha file backend is single-writer: run it behind one adapter/service when
multiple surfaces may write concurrently.

See [Architecture](docs/ARCHITECTURE.md) and the
[Adapter contract](docs/ADAPTERS.md).

## Not another semantic memory

Trajecta intentionally has a narrower job than
[Agent Memory Core](https://github.com/tamvi-journal/agent-memory-core):

| | Trajecta | Agent Memory Core |
|---|---|---|
| Primary question | What are we doing, what changed, and where do we resume? | What does the agent currently know or believe, and why? |
| Unit | Work delta, branch, transfer packet | Semantic record, evidence, revision |
| Fast path | Cross-surface task continuity | Cue/graph semantic recall |
| History | Work and contract chronology | Belief and evidence chronology |

They can be composed, but neither silently owns identity, authority, or private
memory.

## Safety and boundaries

Trajecta does not scrape hidden model state, dump transcripts, discover “the
latest tab,” or claim transport delivery. It stores the fields the host
explicitly submits. A transfer packet is candidate context; current user input
and current workspace evidence remain authoritative.

The core contains no private agent identity, relationship history, credentials,
provider prompt, or product-specific tunnel. See [SECURITY.md](SECURITY.md).

## Project status

`0.1.0` is an alpha kernel: work lifecycle, cue routing, immutable contract
anchors, bounded transfer packets, and cloud ⇄ local round-trip behavior are
tested. The kernel also ships a **verified resume proof**: stale resume attempts
are rejected with receipts, interrupted operations recover, and local resume
envelopes are strict (`npm run proof`). Product adapters and the separately
governed slow-learning layer remain future work.

Trajecta targets macOS, Linux and Windows as equals. See the locked
[cross-platform product contract](docs/specs/2026-09-16-cross-platform-product-contract-v1.md).
CI runs `npm run check` on all three.

## Composition

Trajecta is the shared work-continuity backbone in the Tam Vị family:

| Package | Question |
|---|---|
| `trajecta-memory` | What are we doing, what changed, where do we resume? |
| [`trajecta-identity-memory`](https://github.com/tamvi-journal/trajecta-identity-memory) | Who is the agent (core, phases, recognition)? Points to work with `work_refs`, never copies it. |
| [`agent-memory-core`](https://github.com/tamvi-journal/agent-memory-core) | What does the agent believe, and why (evidence, revisions)? |

## Origin

Trajecta is a public, consumer-neutral distillation of work-continuity patterns
developed in Lam Work Memory by Ty and Lam. It publishes the mechanism, not the
private memory, identity, infrastructure, or operating history that motivated
it.

## License

Apache License 2.0.

---

<div align="center"><sub>Cloud thinks. Local builds. The work keeps moving.</sub></div>
