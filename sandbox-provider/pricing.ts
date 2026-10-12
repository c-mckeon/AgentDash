/** Modal's sandbox rates (USD), from `modal billing rates` on 2026-10-12. */
export const SANDBOX_CPU_CORE_SECOND_USD = 0.1419 / 3600;
export const SANDBOX_MEMORY_GIB_SECOND_USD = 0.024 / 3600;

export interface SandboxSize {
  /** Modal physical cores (1 core = 2 vCPU). Also used as the hard limit. */
  cpuCores: number;
  memoryMiB: number;
}

export const DEFAULT_SIZE: SandboxSize = { cpuCores: 1, memoryMiB: 1024 };

export function usdPerSecond(size: SandboxSize): number {
  return (
    size.cpuCores * SANDBOX_CPU_CORE_SECOND_USD +
    (size.memoryMiB / 1024) * SANDBOX_MEMORY_GIB_SECOND_USD
  );
}

/** Estimated cost of a sandbox of this size living for this long. */
export function costUsd(size: SandboxSize, seconds: number): number {
  return Math.max(seconds, 0) * usdPerSecond(size);
}
