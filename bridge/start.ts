import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type BridgeConfig } from "./config.js";
import { BridgeGatewayClient } from "./gateway-client.js";
import { createServer } from "./server.js";

async function waitForGateway(url: string, maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const client = new BridgeGatewayClient(url);
      await Promise.race([
        client.start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      client.stop();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Gateway did not become ready within ${maxWaitMs}ms`);
}

function resolveGatewayCommand(): { cmd: string; args: string[]; cwd?: string } {
  const openclawDir = process.env.OPENCLAW_DIR;

  // 1. Explicit OPENCLAW_DIR (local dev or custom path)
  if (openclawDir) {
    const openclawMjs = path.join(openclawDir, "openclaw.mjs");
    if (fs.existsSync(openclawMjs)) {
      console.log(`[bridge] Using OPENCLAW_DIR: ${openclawDir}`);
      return { cmd: process.execPath, args: [openclawMjs], cwd: openclawDir };
    }
    // Dev mode: scripts/run-node.mjs
    const runNode = path.join(openclawDir, "scripts", "run-node.mjs");
    if (fs.existsSync(runNode)) {
      console.log("[bridge] Dev mode: using run-node.mjs (will auto-build if needed)");
      return { cmd: process.execPath, args: [runNode], cwd: openclawDir };
    }
  }

  // 2. Globally npm-installed openclaw command
  try {
    execSync("which openclaw", { stdio: "ignore" });
    console.log("[bridge] Using globally installed openclaw");
    return { cmd: "openclaw", args: [] };
  } catch { /* not in PATH */ }

  // 3. Fallback: openclaw.mjs in cwd (legacy mode)
  const cwdMjs = path.join(process.cwd(), "openclaw.mjs");
  if (fs.existsSync(cwdMjs)) {
    console.log("[bridge] Fallback: using openclaw.mjs in cwd");
    return { cmd: process.execPath, args: [cwdMjs] };
  }

  throw new Error(
    "Cannot find openclaw. Set OPENCLAW_DIR, install openclaw globally (npm i -g openclaw), " +
    "or ensure openclaw.mjs exists in the working directory."
  );
}


async function main(): Promise<void> {
  console.log("[bridge] Starting openclaw bridge...");

  const config = loadConfig();

  // Resolve how to launch the openclaw gateway
  const { cmd: gatewayCmd, args: gatewayBaseArgs, cwd: gatewayCwd } = resolveGatewayCommand();

  // Gateway always binds to loopback (no auth needed). External access goes
  // through the bridge WS relay on bridgePort instead.
  const gatewayArgs = [
    ...gatewayBaseArgs,
    "gateway", "run",
    "--port", String(config.gatewayPort),
    "--bind", "loopback",
    "--force",
  ];

  console.log(`[bridge] Starting openclaw gateway: ${gatewayCmd} ${gatewayArgs.join(" ")}`);
  const gatewayProc = spawn(gatewayCmd, gatewayArgs, {
    cwd: gatewayCwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(config.openclawHome, "openclaw.json"),
      OPENCLAW_STATE_DIR: config.openclawHome,
      OPENCLAW_SKIP_CHANNELS: "1",
    },
  });

  gatewayProc.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[gateway] ${data}`);
  });
  gatewayProc.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[gateway] ${data}`);
  });
  gatewayProc.on("exit", (code) => {
    console.error(`[bridge] Gateway process exited with code ${code}`);
    if (code !== 0) process.exit(1);
  });

  // Wait for gateway to be ready
  const gatewayUrl = `ws://127.0.0.1:${config.gatewayPort}`;
  console.log(`[bridge] Waiting for gateway at ${gatewayUrl}...`);
  await waitForGateway(gatewayUrl);
  console.log("[bridge] Gateway is ready");

  // Connect bridge client to gateway
  const client = new BridgeGatewayClient(gatewayUrl);
  await client.start();
  console.log("[bridge] Connected to gateway");

  // Start bridge HTTP server
  const server = createServer(client, config);
  server.listen(config.bridgePort, "0.0.0.0", () => {
    console.log(`[bridge] Bridge server listening on port ${config.bridgePort}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[bridge] Shutting down...");
    client.stop();
    gatewayProc.kill("SIGTERM");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[bridge] Fatal error:", err);
  process.exit(1);
});
