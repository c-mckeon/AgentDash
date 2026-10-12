import type { SandboxSize } from "./pricing.ts";

/**
 * The boundary between the orchestrator and disposable computers.
 *
 * The orchestrator and harness only ever see these types, so the vendor
 * behind them can change without touching the rest of the system.
 */
export interface SandboxProvider {
  create(options: CreateOptions): Promise<Sandbox>;
}

export interface CreateOptions {
  /** Recorded on the sandbox so a stray one can be traced back to its run. */
  runId: string;
  size?: SandboxSize;
  /** The vendor destroys the sandbox after this long even if we never do. */
  maxLifetimeSeconds?: number;
}

export interface Sandbox {
  readonly id: string;
  readonly size: SandboxSize;
  exec(command: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Create or overwrite a text file. The directory must already exist. */
  writeFile(path: string, content: string): Promise<void>;
  /** Stop the sandbox and report how long it lived and roughly what it cost. */
  destroy(): Promise<DestroyReport>;
}

export interface ExecOptions {
  /** Directory to run in. Defaults to the sandbox's working directory. */
  workdir?: string;
  timeoutSeconds?: number;
  /** Extra environment variables for this command only. */
  env?: Record<string, string>;
  /** Called with each complete line of output as it arrives, for live progress. */
  onStdoutLine?: (line: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  seconds: number;
  /** True if the command was cut off at its timeout. */
  timedOut: boolean;
}

export interface DestroyReport {
  lifetimeSeconds: number;
  /** From the reserved size and lifetime. The vendor's bill is the truth. */
  estimatedCostUsd: number;
}
