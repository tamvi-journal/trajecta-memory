import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = new URL("..", import.meta.url).pathname;

function copyRequiredTrackedSources() {
  const tracked = spawnSync("git", ["ls-files", "src", "examples", "package.json"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-proof-source-"));
  for (const relative of tracked.stdout.split("\n").filter(Boolean)) {
    const destination = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, relative), destination);
  }
  return sourceRoot;
}

function runIsolated() {
  const sourceRoot = copyRequiredTrackedSources();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trajecta-proof-state-"));
  const examplePath = path.join(sourceRoot, "examples", "verified-resume-proof.ts");
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", examplePath], {
      cwd: sourceRoot,
      env: { ...process.env, TRAJECTA_PROOF_ROOT: path.join(stateRoot, ".trajecta") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(stateRoot, ".trajecta", "state.json")), true);
    assert.equal(fs.existsSync(path.join(stateRoot, ".trajecta", "proof-attempts.jsonl")), true);
    assert.match(result.stdout, /REJECTED\s+REVISION_CONFLICT/);
    assert.match(result.stdout, /ACCEPTED\s+RESUMED/);
    assert.match(result.stdout, /same receipt \/ revision remains/);
    assert.doesNotMatch(result.stdout, /mst_|api[_ -]?key|pinksilkpham/i);
    return {
      sourceRoot,
      stateRoot,
      examplePath,
      semantic: result.stdout
        .replace(/(?:work|branch|packet|receipt|delta):[A-Za-z0-9._-]+/g, "$ID")
        .replace(/2026-[^\s]+/g, "$TIME"),
    };
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
}

test("P12 two copied clean source trees reproduce the same semantic proof", () => {
  const first = runIsolated();
  const second = runIsolated();
  assert.notEqual(first.sourceRoot, second.sourceRoot);
  assert.notEqual(first.stateRoot, second.stateRoot);
  assert.ok(first.examplePath.startsWith(first.sourceRoot));
  assert.ok(second.examplePath.startsWith(second.sourceRoot));
  assert.equal(first.semantic, second.semantic);
});
