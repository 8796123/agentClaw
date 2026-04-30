import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, writeOpenclawConfig } from "./config.js";

function run(command: string, args: string[], env?: NodeJS.ProcessEnv, cwd?: string): number {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ...env,
    },
  });

  if (result.error) {
    console.warn(`[init] ${command} ${args.join(" ")} failed: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function ensureDirectories(config: ReturnType<typeof loadConfig>): void {
  fs.mkdirSync(config.openclawHome, { recursive: true });
  fs.mkdirSync(config.workspacePath, { recursive: true });
  fs.mkdirSync(config.uploadsPath, { recursive: true });
  fs.mkdirSync(config.sessionsPath, { recursive: true });
  fs.mkdirSync(path.join(config.openclawHome, "skills"), { recursive: true });
  fs.mkdirSync(path.join(config.openclawHome, "extensions"), { recursive: true });
}

function installLocalPlugins(config: ReturnType<typeof loadConfig>): Array<{ name: string; status: "installed" | "failed"; exitCode: number }> {
  const localPluginsDir = "/app/plugins";
  const extensionsDir = path.join(config.openclawHome, "extensions");
  const results: Array<{ name: string; status: "installed" | "failed"; exitCode: number }> = [];

  if (!fs.existsSync(localPluginsDir)) {
    return results;
  }

  console.log(`[init] Found local plugins directory: ${localPluginsDir}`);
  console.log(`[init] openclaw_home: ${config.openclawHome}, home: ${process.env.HOME ?? ""}`);
  fs.mkdirSync(extensionsDir, { recursive: true });

  for (const entry of fs.readdirSync(localPluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(localPluginsDir, entry.name);
    const pluginTarget = path.join(extensionsDir, entry.name);
    console.log(`[init] Installing local plugin: ${entry.name}`);

    try {
      if (fs.existsSync(pluginTarget)) {
        console.log(`[init] Removing existing plugin directory: ${entry.name}`);
        fs.rmSync(pluginTarget, { recursive: true, force: true });
      }

      console.log(`[init] Copying plugin files to: ${pluginTarget}`);
      fs.cpSync(pluginDir, pluginTarget, { recursive: true });

      const packageJsonPath = path.join(pluginTarget, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        console.log(`[init] Installing dependencies for plugin: ${entry.name}`);
        const installExitCode = run("npm", ["install"], undefined, pluginTarget);
        if (installExitCode !== 0) {
          console.warn(`[init] npm install failed for plugin: ${entry.name}, exitCode=${installExitCode}`);
          results.push({ name: entry.name, status: "failed", exitCode: installExitCode });
          continue;
        }

        console.log(`[init] Rebuilding native modules for plugin: ${entry.name}`);
        const rebuildExitCode = run("npm", ["rebuild"], undefined, pluginTarget);
        if (rebuildExitCode !== 0) {
          console.warn(`[init] npm rebuild failed for plugin: ${entry.name}, exitCode=${rebuildExitCode}`);
          results.push({ name: entry.name, status: "failed", exitCode: rebuildExitCode });
          continue;
        }
      } else {
        console.warn(`[init] Warning: No package.json found in plugin: ${entry.name}`);
      }

      console.log(`[init] Local plugin installed: ${entry.name}`);
      results.push({ name: entry.name, status: "installed", exitCode: 0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[init] Local plugin install failed: ${entry.name}, ${message}`);
      results.push({ name: entry.name, status: "failed", exitCode: 1 });
    }
  }

  return results;
}

function main(): void {
  const config = loadConfig();
  const markerPath = process.env.BRIDGE_INIT_MARKER || path.join(config.openclawHome, ".bridge-init-done");
  const initMode = process.env.BRIDGE_INIT_MODE || "once";

  if (initMode === "skip") {
    console.log(`[init] Initialization skipped: mode=${initMode}`);
    return;
  }

  if (initMode !== "always" && fs.existsSync(markerPath)) {
    console.log(`[init] Initialization already completed: ${markerPath}`);
    return;
  }

  console.log(`[init] Running bridge initialization: mode=${initMode}`);

  ensureDirectories(config);
  writeOpenclawConfig(config);
  const pluginResults = installLocalPlugins(config);

  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    initializedAt: new Date().toISOString(),
    pluginResults,
  }, null, 2), "utf-8");

  console.log(`[init] Initialization completed: ${markerPath}`);
}

main();