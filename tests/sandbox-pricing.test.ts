import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SIZE, costUsd, usdPerSecond } from "../sandbox-provider/pricing.ts";

const close = (actual: number, expected: number, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is not close to ${expected}`);

test("default sandbox costs about 16.6 cents an hour", () => {
  close(usdPerSecond(DEFAULT_SIZE) * 3600, 0.1419 + 0.024, 1e-6);
});

test("rate scales with cores and memory", () => {
  const small = usdPerSecond({ cpuCores: 0.5, memoryMiB: 512 });
  const large = usdPerSecond({ cpuCores: 1, memoryMiB: 1024 });
  close(large, small * 2);
});

test("cost is rate times seconds", () => {
  close(costUsd(DEFAULT_SIZE, 60), usdPerSecond(DEFAULT_SIZE) * 60);
});

test("negative durations cost nothing", () => {
  assert.equal(costUsd(DEFAULT_SIZE, -10), 0);
});
