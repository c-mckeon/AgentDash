import { ModalClient } from "modal";
import type { Sandbox as ModalSandbox } from "modal";

import { SANDBOX_IMAGE } from "../sandbox/image.ts";
import { DEFAULT_SIZE, costUsd } from "./pricing.ts";
import type { SandboxSize } from "./pricing.ts";
import type {
  CreateOptions,
  DestroyReport,
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxProvider,
} from "./types.ts";

const APP_NAME = "agentdash-sandboxes";
const DEFAULT_MAX_LIFETIME_SECONDS = 600;
const DEFAULT_EXEC_TIMEOUT_SECONDS = 60;
/** Same code the `timeout` shell command uses. */
const TIMEOUT_EXIT_CODE = 124;
/** 128 + SIGKILL: what a command killed by the sandbox reports. */
const KILLED_EXIT_CODE = 137;

/** Disposable computers on Modal. Credentials come from the local Modal profile. */
export class ModalSandboxProvider implements SandboxProvider {
  readonly #modal = new ModalClient();

  async create(options: CreateOptions): Promise<Sandbox> {
    const size = options.size ?? DEFAULT_SIZE;
    const startedAt = Date.now();
    const app = await this.#modal.apps.fromName(APP_NAME, { createIfMissing: true });
    const image = this.#modal.images
      .fromRegistry(SANDBOX_IMAGE.base)
      .dockerfileCommands([...SANDBOX_IMAGE.setup]);
    const sandbox = await this.#modal.sandboxes.create(app, image, {
      cpu: size.cpuCores,
      // Modal bills CPU used above the reservation, so cap it there to keep
      // the cost of a sandbox-second predictable.
      cpuLimit: size.cpuCores,
      memoryMiB: size.memoryMiB,
      timeoutMs: (options.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS) * 1000,
      workdir: SANDBOX_IMAGE.workdir,
      tags: { run_id: options.runId },
    });
    return new ModalSandboxHandle(sandbox, size, startedAt);
  }

  close(): void {
    this.#modal.close();
  }
}

class ModalSandboxHandle implements Sandbox {
  readonly #sandbox: ModalSandbox;
  readonly #startedAt: number;
  readonly size: SandboxSize;

  constructor(sandbox: ModalSandbox, size: SandboxSize, startedAt: number) {
    this.#sandbox = sandbox;
    this.size = size;
    this.#startedAt = startedAt;
  }

  get id(): string {
    return this.#sandbox.sandboxId;
  }

  async exec(command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_SECONDS;
    const started = Date.now();
    const process = await this.#sandbox.exec(command, {
      mode: "text",
      workdir: options.workdir,
      timeoutMs: timeoutSeconds * 1000,
      env: options.env,
    });
    const readStdout = async (): Promise<string> => {
      if (!options.onStdoutLine) return process.stdout.readText();
      let all = "";
      let pending = "";
      for await (const chunk of process.stdout) {
        all += chunk;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) options.onStdoutLine(line);
      }
      if (pending) options.onStdoutLine(pending);
      return all;
    };
    const [stdout, stderr, exitCode] = await Promise.allSettled([
      readStdout(),
      process.stderr.readText(),
      process.wait(),
    ]);
    const seconds = (Date.now() - started) / 1000;
    const failure = [stdout, stderr, exitCode].find((outcome) => outcome.status === "rejected");
    if (failure) {
      // The SDK signals a command timeout by throwing while reading its output.
      // Anything that fails before the deadline is a real error.
      if (seconds < timeoutSeconds) throw failure.reason;
      return {
        stdout: stdout.status === "fulfilled" ? stdout.value : "",
        stderr: stderr.status === "fulfilled" ? stderr.value : "",
        exitCode: TIMEOUT_EXIT_CODE,
        seconds,
        timedOut: true,
      };
    }
    const code = (exitCode as PromiseFulfilledResult<number>).value;
    // More often the SDK kills the command at the deadline and reports 137.
    const killedAtDeadline = code === KILLED_EXIT_CODE && seconds >= timeoutSeconds;
    return {
      stdout: (stdout as PromiseFulfilledResult<string>).value,
      stderr: (stderr as PromiseFulfilledResult<string>).value,
      exitCode: killedAtDeadline ? TIMEOUT_EXIT_CODE : code,
      seconds,
      timedOut: killedAtDeadline,
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.#sandbox.filesystem.writeText(content, path);
  }

  async destroy(): Promise<DestroyReport> {
    await this.#sandbox.terminate();
    const lifetimeSeconds = (Date.now() - this.#startedAt) / 1000;
    return { lifetimeSeconds, estimatedCostUsd: costUsd(this.size, lifetimeSeconds) };
  }

  /** Null while the sandbox is running, its exit code once it has stopped. */
  poll(): Promise<number | null> {
    return this.#sandbox.poll();
  }
}
