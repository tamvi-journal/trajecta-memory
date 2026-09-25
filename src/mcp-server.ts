#!/usr/bin/env -S node --experimental-strip-types
import { runStdio } from "./mcp.ts";

runStdio().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
