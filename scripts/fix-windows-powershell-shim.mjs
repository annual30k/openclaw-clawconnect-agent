import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "clawconnect-agent";
const COMMAND_NAME = "clawconnect";
const CLI_ENTRY = `node_modules/${PACKAGE_NAME}/dist/index.js`;

export function isGlobalNpmLifecycle(env) {
  return env.npm_config_global === "true" || env.npm_config_location === "global";
}

export function resolveWindowsShimPaths(packageRoot) {
  const nodeModulesDirectory = dirname(packageRoot);
  if (
    basename(packageRoot).toLowerCase() !== PACKAGE_NAME
    || basename(nodeModulesDirectory).toLowerCase() !== "node_modules"
  ) {
    return null;
  }

  const npmPrefix = dirname(nodeModulesDirectory);
  return {
    cmdPath: resolve(npmPrefix, `${COMMAND_NAME}.cmd`),
    ps1Path: resolve(npmPrefix, `${COMMAND_NAME}.ps1`),
  };
}

export function isClawConnectPowerShellShim(content) {
  return content.replaceAll("\\", "/").toLowerCase().includes(CLI_ENTRY);
}

export function removeWindowsPowerShellShim({
  platform = process.platform,
  env = process.env,
  packageRoot,
  fileExists = existsSync,
  readFile = readFileSync,
  removeFile = unlinkSync,
}) {
  if (platform !== "win32" || !isGlobalNpmLifecycle(env)) {
    return false;
  }

  const paths = resolveWindowsShimPaths(packageRoot);
  if (!paths || !fileExists(paths.cmdPath) || !fileExists(paths.ps1Path)) {
    return false;
  }

  // 只移除 npm 为本包生成的 shim，并要求同目录的 .cmd 入口已存在，避免误删用户脚本或破坏 CLI。
  const ps1Content = readFile(paths.ps1Path, "utf8");
  if (!isClawConnectPowerShellShim(ps1Content)) {
    return false;
  }

  removeFile(paths.ps1Path);
  return true;
}

function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const packageRoot = process.env.npm_lifecycle_event === "postinstall"
    ? process.cwd()
    : resolve(dirname(scriptPath), "..");

  try {
    removeWindowsPowerShellShim({ packageRoot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[clawconnect] Unable to remove the npm PowerShell shim (${message}). `
      + "If scripts are restricted, run clawconnect.cmd instead.",
    );
  }
}

if (
  process.env.npm_lifecycle_event === "postinstall"
  || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
) {
  main();
}
