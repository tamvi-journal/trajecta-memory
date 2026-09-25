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
