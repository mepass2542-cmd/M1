import app from "./app";
import { logger } from "./lib/logger";
import { spawn } from "child_process";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// In artifact/deployment mode the dashboard server must be started alongside
// the api-server proxy (which forwards all traffic to port 5000).
if (process.env.NODE_ENV !== "development") {
  const dashboard = spawn(
    "pnpm",
    ["--filter", "@workspace/dashboard", "run", "start"],
    {
      env: { ...process.env, PORT: "5000" },
      stdio: "inherit",
    },
  );

  dashboard.on("error", (err) => {
    logger.error({ err }, "Failed to spawn dashboard process");
  });

  dashboard.on("exit", (code) => {
    logger.error({ code }, "Dashboard process exited unexpectedly");
    process.exit(code ?? 1);
  });

  logger.info("Dashboard server spawned on port 5000");
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
