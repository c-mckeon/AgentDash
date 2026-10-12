/** Starts the API with a real database and real sandboxes.  node api/main.ts */
import { loadConfig } from "../config.ts";
import { Db } from "../db/index.ts";
import { executeRun } from "../orchestrator/run.ts";
import { ModalSandboxProvider } from "../sandbox-provider/modal.ts";
import { createApi } from "./server.ts";

process.loadEnvFile(".env");
const config = loadConfig();
const db = new Db(config.dbPath);
const sandboxes = new ModalSandboxProvider();

const api = createApi({
  db,
  ownerToken: config.ownerToken,
  // One run at a time is the v1 rule; runs started together simply overlap for now.
  startRun: (runId) => void executeRun({ db, sandboxes, config }, runId),
});

api.listen(config.port, () => console.log(`AgentDash API listening on http://localhost:${config.port}`));
