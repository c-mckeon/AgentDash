/**
 * Live check of the sandbox provider: create one, use it the way a run will,
 * destroy it. Costs well under a cent.
 *
 *   node sandbox-provider/try-it.ts
 */
import { ModalSandboxProvider } from "./modal.ts";

process.loadEnvFile(".env");
const gatewayUrl = process.env.GATEWAY_URL ?? "";
const REPO = "https://github.com/octocat/Hello-World.git";

const provider = new ModalSandboxProvider();
const report: Record<string, unknown> = {};
const createStarted = Date.now();
const sandbox = await provider.create({ runId: "try-it", maxLifetimeSeconds: 300 });
report.createSeconds = (Date.now() - createStarted) / 1000;
report.sandboxId = sandbox.id;

try {
  const step = async (name: string, command: string[], options = {}) => {
    const result = await sandbox.exec(command, options);
    report[name] = {
      exitCode: result.exitCode,
      seconds: Number(result.seconds.toFixed(2)),
      timedOut: result.timedOut,
      stdout: result.stdout.trim().slice(0, 400),
      stderr: result.stderr.trim().slice(0, 200),
    };
    return result;
  };

  await step("echo", ["echo", "hello from the sandbox"]);
  await step("tools", ["sh", "-c", "git --version && rg --version | head -1 && node --version && pwd && nproc"]);
  await step("clone", ["git", "clone", "--depth", "1", REPO, "repo"]);
  await step("edit", ["sh", "-c", "echo 'Edited inside a sandbox.' >> README"], { workdir: "/workspace/repo" });
  await step("patch", ["git", "diff"], { workdir: "/workspace/repo" });
  await step("reachGateway", ["curl", "-s", "-m", "20", "-w", " %{http_code}", `${gatewayUrl}/health`]);
  await step("nonZeroExit", ["sh", "-c", "echo oops >&2; exit 3"]);
  await step("timeout", ["sleep", "15"], { timeoutSeconds: 3 });
  await step("stillAlive", ["echo", "still usable after a timed-out command"]);
} finally {
  report.destroy = await sandbox.destroy();
  // A stopped sandbox has an exit code; a running one polls as null.
  const handle = sandbox as unknown as { poll(): Promise<number | null> };
  await new Promise((resolve) => setTimeout(resolve, 3000));
  report.exitCodeAfterDestroy = await handle.poll();
  provider.close();
}

console.log(JSON.stringify(report, null, 2));
