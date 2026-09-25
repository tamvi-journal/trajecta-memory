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
