/** Explicit provider/library rejection only; transport prose cannot prove non-submission. */
export function isExplicitWalletRejection(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const code = Object.getOwnPropertyDescriptor(reason, "code");
  return !!code && "value" in code && (code.value === 4001 || code.value === "ACTION_REJECTED");
}
