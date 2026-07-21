import { extname } from "node:path";

export interface ProcessInvocation {
  command: string;
  args: string[];
}

/** Windows 不能由 CreateProcess 直接执行 .cmd/.bat；统一经 cmd.exe，JS 入口统一经当前 Node。 */
export function buildExecutableInvocation(
  executable: string,
  args: string[],
  options: {
    platform?: NodeJS.Platform;
    nodePath?: string;
    commandShell?: string;
    powershellPath?: string;
  } = {},
): ProcessInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: executable, args };
  }

  const extension = extname(executable).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    return { command: options.nodePath ?? process.execPath, args: [executable, ...args] };
  }
  if (extension === ".cmd" || extension === ".bat") {
    return {
      command: options.commandShell ?? process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", buildWindowsCommandLine([executable, ...args])],
    };
  }
  if (extension === ".ps1") {
    return {
      command: options.powershellPath ?? "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-File", executable, ...args],
    };
  }
  return { command: executable, args };
}

export function buildWindowsCommandLine(args: string[]): string {
  return args.map(quoteWindowsArgument).join(" ");
}

export function buildShellCommandInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ProcessInvocation {
  if (platform !== "win32") {
    return { command: "sh", args: ["-lc", command] };
  }
  const utf8Bootstrap = [
    "$utf8NoBom = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $utf8NoBom",
    "[Console]::OutputEncoding = $utf8NoBom",
    "$OutputEncoding = $utf8NoBom",
    command,
  ].join("; ");
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", utf8Bootstrap],
  };
}

export function quoteShellArgument(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteWindowsArgument(arg: string): string {
  if (!/[\s"]/.test(arg)) {
    return arg;
  }
  let result = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return result + "\\".repeat(backslashes * 2) + '"';
}
