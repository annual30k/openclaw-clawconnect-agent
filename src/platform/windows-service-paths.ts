import { join } from "path";
import { getProfileLogDir } from "./service-manager-common.js";
import { normalizeProfileName } from "../config/profile.js";

export const WINDOWS_SERVICE_BASE_NAME = "ClawConnectAgent";
export const WINDOWS_SERVICE_HOST_EXE_NAME = "clawconnect-service-host.exe";
export const WINDOWS_SERVICE_HOST_SOURCE_NAME = "clawconnect-service-host.cs";
export const WINDOWS_SERVICE_HOST_CONFIG_NAME = "clawconnect-service-host.conf";
/** 旧版（计划任务时代）的 PowerShell runner，仅用于识别并清理遗留进程。 */
export const LEGACY_WINDOWS_RUNNER_NAME = "clawconnect-service.ps1";

/**
 * Windows 服务名：默认 profile 为 ClawConnectAgent，具名 profile 追加 `-<profile>`，
 * 与旧计划任务同名，便于迁移时一一对应。
 */
export function windowsServiceName(profile?: string): string {
  const normalized = normalizeProfileName(profile);
  return normalized ? `${WINDOWS_SERVICE_BASE_NAME}-${normalized}` : WINDOWS_SERVICE_BASE_NAME;
}

export function windowsServiceHostExePath(profile?: string): string {
  return join(getProfileLogDir(profile), WINDOWS_SERVICE_HOST_EXE_NAME);
}

export function windowsServiceHostSourcePath(profile?: string): string {
  return join(getProfileLogDir(profile), WINDOWS_SERVICE_HOST_SOURCE_NAME);
}

export function windowsServiceHostConfigPath(profile?: string): string {
  return join(getProfileLogDir(profile), WINDOWS_SERVICE_HOST_CONFIG_NAME);
}

export function windowsServiceRunnerPath(profile?: string): string {
  return join(getProfileLogDir(profile), LEGACY_WINDOWS_RUNNER_NAME);
}
