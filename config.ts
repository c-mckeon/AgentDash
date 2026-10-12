/** Environment ↔ application. Everything configurable is read here, once. */

export interface Config {
  gatewayUrl: string;
  /** Owner key for the gateway. Also the secret that signs per-run tokens. */
  gatewayKey: string;
  /** Required to start or kill runs through the API. */
  ownerToken: string;
  dbPath: string;
  port: number;
  /** How long a run's gateway pass stays valid. */
  runTokenTtlSeconds: number;
  /** Modal destroys a run's sandbox after this long even if we never do. */
  sandboxMaxLifetimeSeconds: number;
  /** The agent is stopped after this many model calls. */
  agentMaxSteps: number;
  /** The agent is stopped after this long, whatever it is doing. */
  agentTimeoutSeconds: number;
}

const REQUIRED = ["GATEWAY_URL", "GATEWAY_KEY", "OWNER_TOKEN"] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  return {
    gatewayUrl: env.GATEWAY_URL!.replace(/\/$/, ""),
    gatewayKey: env.GATEWAY_KEY!,
    ownerToken: env.OWNER_TOKEN!,
    dbPath: env.DB_PATH ?? "agentdash.db",
    port: Number(env.PORT ?? 8787),
    runTokenTtlSeconds: Number(env.RUN_TOKEN_TTL_SECONDS ?? 900),
    sandboxMaxLifetimeSeconds: Number(env.SANDBOX_MAX_LIFETIME_SECONDS ?? 600),
    agentMaxSteps: Number(env.AGENT_MAX_STEPS ?? 8),
    agentTimeoutSeconds: Number(env.AGENT_TIMEOUT_SECONDS ?? 300),
  };
}
