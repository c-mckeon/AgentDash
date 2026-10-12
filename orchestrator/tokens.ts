/**
 * Per-run passes for the gateway.
 *
 * A pass is "<runId>.<expiry>.<signature>". The orchestrator signs it with the
 * gateway key; the gateway checks the signature and expiry without needing a
 * database. A sandbox holds only this, never the key itself.
 * gateway/core.py implements the same format and must stay in step.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function signRunToken(secret: string, runId: string, expiresAt: number): string {
  const payload = `${runId}.${Math.floor(expiresAt)}`;
  return `${payload}.${signature(secret, payload)}`;
}

/** The run id if the pass is genuine and unexpired, otherwise null. */
export function verifyRunToken(secret: string, token: string, now: number): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [runId, expiry, given] = parts;
  const expected = signature(secret, `${runId}.${expiry}`);
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
  if (!/^\d+$/.test(expiry) || now >= Number(expiry)) return null;
  return runId;
}
