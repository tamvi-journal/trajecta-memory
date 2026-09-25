import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalStoreDigest, OperationConflict, OperationInDoubt, TrajectaStore } from "../src/index.ts";
import { writeAll } from "../src/store.ts";
import type { StoreFaultPoint } from "../src/index.ts";

const now = () => new Date("2026-09-05T00:00:00.000Z");

function fixture(failAt?: StoreFaultPoint) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-kernel-recovery-"));
  let armed = false;
  const store = new TrajectaStore(root, now, (point) => {
    if (armed && point === failAt) throw new Error(`fault:${point}`);
  });
  const opened = store.open({
    operationId: "operation:recovery-open",
    topic: "Recovery",
    goal: "Resume once after interruption",
    surface: { kind: "local", name: "Local workspace", session: "local:recovery" },
    initialBranch: {
      label: "recovery",
      purpose: "Prove WAL recovery",
      cues: ["recovery"],
      returnPoint: "Compare revision and operation receipt",
    },
  });
  armed = true;
  const input = {
    operationId: "operation:recovery-resume",
    workId: opened.work.id,
    expectedRevision: opened.work.revision,
    surface: { kind: "local" as const, name: "Local workspace", session: "local:recovery" },
    instruction: "Continue exact recovery task",
  };
  return { root, store, opened, input };
}

for (const point of ["after-reserve", "after-delta", "after-state"] as const) {
  test(`kernel replay recovers a ${point} interruption exactly once`, () => {
    const f = fixture(point);
    try {
      assert.throws(() => f.store.resume(f.input), new RegExp(`fault:${point}`));
      const recovered = new TrajectaStore(f.root, now).resume(f.input);
      assert.equal(recovered.work.revision, f.opened.work.revision + 1);
      assert.deepEqual(new TrajectaStore(f.root, now).resume(f.input), recovered);
      assert.equal(new TrajectaStore(f.root, now).history(f.opened.work.id)
        .filter((delta) => delta.operationId === f.input.operationId).length, 1);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test("kernel rejects changed input after a reserved operation", () => {
  const f = fixture("after-reserve");
  try {
    assert.throws(() => f.store.resume(f.input), /fault:after-reserve/);
    assert.throws(() => new TrajectaStore(f.root, now).resume({
      ...f.input,
      instruction: "Different instruction",
    }), OperationConflict);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("kernel refuses recovery when live state matches neither WAL boundary", () => {
  const f = fixture("after-reserve");
  try {
    assert.throws(() => f.store.resume(f.input), /fault:after-reserve/);
    const stateFile = path.join(f.root, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.work[0].revision += 7;
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    assert.throws(() => new TrajectaStore(f.root, now).resume(f.input), OperationInDoubt);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("kernel treats a torn final operation record as in doubt", () => {
  const f = fixture("after-reserve");
  try {
    assert.throws(() => f.store.resume(f.input), /fault:after-reserve/);
    fs.appendFileSync(path.join(f.root, "operations.jsonl"), '{"schema":');
    assert.throws(() => new TrajectaStore(f.root, now).resume(f.input), OperationInDoubt);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("kernel treats a torn final delta after reservation as in doubt", () => {
  const f = fixture("after-reserve");
  try {
    assert.throws(() => f.store.resume(f.input), /fault:after-reserve/);
    const deltasFile = path.join(f.root, "deltas.jsonl");
    fs.appendFileSync(deltasFile, '{"schema":');
    const tornBytes = fs.readFileSync(deltasFile);
    assert.throws(() => new TrajectaStore(f.root, now).resume(f.input), OperationInDoubt);
    assert.deepEqual(fs.readFileSync(deltasFile), tornBytes);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "state.json"), "utf8"))
      .work[0].revision, f.opened.work.revision);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("kernel v2 digest treats equivalent object key order as the same input", () => {
  const left = { z: 1, nested: { y: true, a: 2 } };
  const right = { nested: { a: 2, y: true }, z: 1 };
  assert.equal(canonicalStoreDigest(left), canonicalStoreDigest(right));
});

test("kernel write-all completes short positive writes", () => {
  const bytes = Buffer.from("durable", "utf8");
  const observed: string[] = [];
  writeAll(17, bytes, (_descriptor, value, offset, length) => {
    const size = Math.min(2, length);
    observed.push(value.subarray(offset, offset + size).toString("utf8"));
    return size;
  });
  assert.deepEqual(observed, ["du", "ra", "bl", "e"]);
});

test("kernel replays an exact committed v1 operation", () => {
  const f = fixture();
  try {
    const committed = f.store.resume(f.input);
    const legacyRecord = {
      operationId: f.input.operationId,
      digest: crypto.createHash("sha256").update(JSON.stringify(f.input)).digest("hex"),
      state: "committed",
      deltaId: committed.delta.id,
      result: committed,
    };
    const operationFile = path.join(f.root, "operations.jsonl");
    const records = fs.readFileSync(operationFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    fs.writeFileSync(operationFile, `${records.filter((record) => record.operationId !== f.input.operationId)
      .concat(legacyRecord).map((record) => JSON.stringify(record)).join("\n")}\n`);
    assert.deepEqual(new TrajectaStore(f.root, now).resume(f.input), committed);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("kernel refuses an internally inconsistent v2 reservation before writing a foreign delta", () => {
  const f = fixture("after-reserve");
  try {
    assert.throws(() => f.store.resume(f.input), /fault:after-reserve/);
    const operationFile = path.join(f.root, "operations.jsonl");
    const records = fs.readFileSync(operationFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const reservation = records.find((record) => record.operationId === f.input.operationId);
    reservation.delta.operationId = "operation:foreign-delta";
    reservation.result.delta.operationId = "operation:foreign-delta";
    fs.writeFileSync(operationFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    assert.throws(() => new TrajectaStore(f.root, now).resume(f.input), OperationInDoubt);
    assert.equal(fs.existsSync(path.join(f.root, "deltas.jsonl")), true);
    assert.equal(new TrajectaStore(f.root, now).history(f.opened.work.id)
      .filter((delta) => delta.operationId === "operation:foreign-delta").length, 0);
    assert.equal(new TrajectaStore(f.root, now).getWork(f.opened.work.id).revision, f.opened.work.revision);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
