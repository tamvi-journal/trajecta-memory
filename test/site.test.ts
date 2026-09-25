import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { describeDemo, initialDemoState, reduceDemo } from "../demo.js";

test("stale revision is rejected before any resume", () => {
  const state = reduceDemo(initialDemoState, "TRY_STALE");
  assert.equal(state, "rejected");
  assert.equal(describeDemo(state).verification, "rejected · revision mismatch");
  assert.equal(describeDemo(state).expectedRevision, "12");
  assert.equal(describeDemo(state).currentRevision, "14");
});

test("verified packet resumes the exact branch", () => {
  const selected = reduceDemo("rejected", "USE_VERIFIED");
  assert.equal(selected, "verified");
  const resumed = reduceDemo(selected, "RESUME");
  assert.equal(resumed, "resumed");
  assert.equal(describeDemo(resumed).branch, "launch-proof");
  assert.equal(describeDemo(resumed).currentRevision, "15");
});

test("replay returns every state to ready", () => assert.equal(reduceDemo("resumed", "REPLAY"), "ready"));

test("every demo view exposes the handoff receipt contract", () => {
  for (const state of ["ready", "rejected", "verified", "resumed"]) {
    const view = describeDemo(state);
    for (const field of ["branch", "provenance", "evidence", "openLoops", "nextAction", "verification", "selectedPacket", "tone"]) assert.ok(view[field], `${state} missing ${field}`);
  }
  assert.equal(describeDemo("ready").selectedPacket, "stale");
  assert.equal(describeDemo("verified").selectedPacket, "current");
  assert.equal(describeDemo("resumed").currentRevision, "15");
});

test("landing page exposes honest conversion and demo hooks", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const demo = fs.readFileSync(new URL("../demo.js", import.meta.url), "utf8");
  assert.match(html, /Run the 90-second handoff demo/);
  assert.match(html, /Adapters in validation/i);
  assert.match(html, /data-demo-root/);
  assert.match(html, /data-action="TRY_STALE"/);
  assert.match(html, /data-action="USE_VERIFIED"/);
  assert.match(html, /data-action="RESUME"/);
  assert.match(html, /data-packet="stale"[^>]*aria-current="true"/);
  assert.match(html, /data-packet="current"[^>]*aria-current="false"/);
  assert.match(html, /data-field="provenance"/);
  assert.match(html, /data-field="evidence"/);
  assert.match(html, /data-field="openLoops"/);
  assert.match(html, /data-state="ready"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /class="hero-demo"[^>]*id="demo"[\s\S]*class="trajectory"[^>]*data-state="ready"/);
  assert.match(demo, /root\.closest\("\.hero-demo"\)\?\.querySelector\("\.trajectory"\)/);
  assert.doesNotMatch(html, /connects live (ChatGPT|Claude|Codex|Cursor)/i);
});

test("stylesheet preserves brand, accessibility, and mobile behavior", () => {
  const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  for (const token of ["#0b1020", "#f4efe6", "#4fd1c5", "#ff6b5e", "#d6a85f"]) assert.match(css.toLowerCase(), new RegExp(token));
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media[^}]*max-width/s);
});

test("landing page local links and assets exist", () => {
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  for (const ref of refs) {
    if (ref.startsWith("#") || /^[a-z]+:/i.test(ref) || ref.startsWith("//")) continue;
    assert.equal(fs.existsSync(path.resolve(path.dirname(fileURLToPath(new URL("../index.html", import.meta.url))), ref)), true, `missing local reference: ${ref}`);
  }
});
