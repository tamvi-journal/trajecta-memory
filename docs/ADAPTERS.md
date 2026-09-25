# Adapter contract

Trajecta deliberately separates **work state** from **transport**. A ChatGPT
app, MCP server, CLI integration, queue, or local hook can all carry the same
`trajecta.transfer/v1` packet.

## Outbound adapter

An outbound adapter should:

1. route a current cue and select one exact work ID;
2. call `transfer(workId, cue, intendedFor, maxBytes)`;
3. preserve the opaque packet and work IDs byte-for-byte;
4. deliver to an exact, authorized target—not a title or frontmost tab;
5. record transport acceptance separately from target read-back.

## Inbound adapter

An inbound adapter should:

1. validate `schema === "trajecta.transfer/v1"`;
2. verify that `intendedFor` matches the receiving surface;
3. show or apply the packet as candidate context;
4. call `resume()` with the exact work ID and `expectedRevision`;
5. surface a revision conflict instead of silently replacing newer work;
6. checkpoint only material changes after execution.

## Receipt levels

Keep these claims separate:

| Receipt | What it proves |
|---|---|
| packet-created | Trajecta rendered bounded state |
| transport-accepted | The transport accepted the payload |
| target-received | The exact target acknowledged it |
| target-resumed | The target passed revision CAS and attached its session |
| outcome-verified | Host evidence verifies the resulting work |

Never promote one receipt level into another by inference.

## Minimal lifecycle hooks

Hosts normally need only four hooks:

- first substantive request: route and resume;
- material decision or correction: capture a delta;
- cross-surface move: capture `handoff`, then render a packet;
- pre-final result: capture an evidence-bearing `outcome`.

Automatic transcript ingestion is intentionally outside the contract.

## First concrete adapter

The implementation contract for the first real ChatGPT-to-Codex slice is
[`docs/specs/2026-09-04-chatgpt-codex-adapter-v1.md`](specs/2026-09-04-chatgpt-codex-adapter-v1.md).
It uses a user-controlled file transport and a single-use exact-target card so
the product can be validated without claiming an unobserved exact-thread
bridge. A later transport may replace the file path without changing the
kernel packet or receipt rules.
