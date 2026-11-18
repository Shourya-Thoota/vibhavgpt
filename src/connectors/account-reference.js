import { createHash } from "node:crypto";

/** An opaque, stable reference to a connected account: enough to tell "the same account" from "a different one", and nothing else. */
export const accountReference = (accountId) => createHash("sha256").update(`drive-account:${String(accountId ?? "")}`).digest("hex").slice(0, 16);
