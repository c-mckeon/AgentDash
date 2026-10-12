/**
 * What is installed on every run's disposable computer.
 *
 * Node is the base because the agent harness (step 4) is TypeScript and runs
 * inside the sandbox. git clones the task's repository and produces the patch;
 * ripgrep backs the harness's search tool.
 */
export const SANDBOX_IMAGE = {
  base: "node:22-slim",
  setup: [
    "RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl && rm -rf /var/lib/apt/lists/*",
    "RUN mkdir -p /workspace",
  ],
  workdir: "/workspace",
} as const;
