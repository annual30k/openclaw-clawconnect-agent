import { execFileSync } from "child_process";
const en = {
    // pair
    "pair.alreadyRegistered": (id) => `Gateway already registered (id=${id}). Refreshing access code…`,
    "pair.invalidCredentials": "Invalid credentials (401). The server doesn't recognize this gateway.\nRun `clawconnect reset` to clear config and re-register.",
    "pair.invalidCredentialsWithCommands": (resetCommand, pairCommand) => `Invalid credentials (401). The server doesn't recognize this gateway.\nRun \`${resetCommand}\` to clear this profile config, then run \`${pairCommand}\` to re-register.`,
    "pair.refreshFailed": (status, body) => `Failed to refresh access code: ${status} ${body}`,
    "pair.registering": "Registering with relay server…",
    "pair.registrationFailed": (status, body) => `Registration failed: ${status} ${body}`,
    "pair.registered": (id) => `Registered! Gateway ID: ${id}`,
    "pair.scanQR": "\nScan this QR code with the ClawConnect mobile app:\n",
    "pair.accessCode": (code) => `\nAccess code (one-time use): ${code}`,
    "pair.installingService": "\nInstalling/updating relay background service…",
    // run
    "run.starting": "Starting ClawConnect host agent…",
    "run.gatewayId": (id) => `  Gateway ID:   ${id}`,
    "run.relayServer": (url) => `  Relay Server: ${url}`,
    "run.gatewayUrl": (url) => `  Gateway URL:  ${url}`,
    "run.connected": "Relay connected.",
    "run.disconnected": "Relay disconnected. Reconnecting…",
    "run.retry": (attempt, delay) => `Retry attempt ${attempt}, waiting ${delay}ms…`,
    // install
    "install.serviceStarted": (manager) => `Service installed and started via ${manager}.`,
    "install.installFailed": (manager) => `Failed to activate service via ${manager}.`,
    "install.serviceFileWritten": (path) => `Service file written to: ${path}`,
    "install.startManually": (command) => `Start manually: ${command}`,
    "install.restarting": "Restarting relay service…",
    "install.serviceRestarted": (manager) => `Service restarted via ${manager}.`,
    "install.restartFailed": (manager) => `Failed to restart service via ${manager}.`,
    "install.stopped": (manager) => `Relay client stopped via ${manager}.`,
    "install.stoppedAndRemoved": (manager) => `Relay client stopped and removed from ${manager}.`,
    "install.noService": "No running relay service found.",
    "install.unsupported": (platform) => `Background service management is not supported on platform: ${platform}`,
    "install.runForeground": "Run `clawconnect run` manually in the foreground instead.",
    "install.configRemoved": (path) => `Config removed: ${path}`,
    "install.removeConfigFailed": "Failed to remove config:",
    "install.noConfig": "No config file found.",
    "install.resetComplete": "\nReset complete. Run `clawconnect pair` to re-register.",
    "install.resetCompleteWithCommand": (command) => `\nReset complete. Run \`${command}\` to re-register.`,
    // update
    "update.localInstallWarning": "Detected a local source checkout. `clawconnect update` only upgrades the globally installed npm package.",
    "update.activePath": (path) => `Active CLI path: ${path}`,
    "update.currentVersion": (version) => `Active CLI version: ${version}`,
    "update.targetVersion": (version) => `Target npm version: ${version}`,
    "update.starting": (pkg) => `Updating ${pkg}…`,
    "update.updated": (pkg) => `${pkg} was updated successfully.`,
    "update.failed": (pkg) => `Failed to update ${pkg}.`,
    "update.verifyFailed": "Update completed, but the active CLI path/version could not be verified.",
    "update.versionMismatch": (expected, actual) => `Update finished, but the active CLI is still ${actual} instead of ${expected}.`,
    "update.pathMismatchHint": (path) => `The current PATH resolves \`clawconnect\` to: ${path}`,
    "update.reinstallingService": "Reinstalling the background service with the active CLI path…",
    "update.restartingService": "Restarting the background service to load the new version…",
    "update.serviceReinstalled": (manager) => `Background service refreshed via ${manager}.`,
    "update.serviceReinstallFailed": (manager) => `Updated successfully, but failed to refresh the background service via ${manager}. Falling back to restart…`,
    "update.serviceRestarted": (manager) => `Background service restarted via ${manager}.`,
    "update.serviceRestartFailed": (manager) => `Updated successfully, but failed to restart the background service via ${manager}.`,
    "update.noServiceRestartNeeded": "No installed background service was detected. The new version will be used the next time you run `clawconnect`.",
    "update.manualHint": (command) => `Run manually: ${command}`,
    // status
    "status.title": "── ClawConnect Agent Status ──\n",
    "status.notPaired": "Config:   ✗  Not paired — run 'clawconnect pair' first",
    "status.paired": "Config:   ✓  Paired",
    "status.displayName": (name) => `  Display name : ${name}`,
    "status.gatewayId": (id) => `  Gateway ID   : ${id}`,
    "status.gatewayType": (type) => `  Gateway type : ${type}`,
    "status.relayServer": (url) => `  Relay server : ${url}`,
    "status.configCorrupted": "Config:   ✗  File exists but is corrupted",
    "status.gateway": (url) => `\nGateway:  ${url}`,
    "status.servicePlatform": (manager) => `\nService Manager: ${manager}`,
    "status.serviceNotInstalled": "\nService:  ✗  Not installed — run 'clawconnect install'",
    "status.serviceRunning": (manager) => `\nService:  ✓  Running (${manager})`,
    "status.serviceLog": (path) => `  Log : ${path}`,
    "status.relayHealth": (icon, detail) => `  Relay   : ${icon}  ${detail}`,
    "status.gatewayHealth": (icon, detail) => `  Gateway : ${icon}  ${detail}`,
    "status.agentHealth": (icon, detail) => `  Agent   : ${icon}  ${detail}`,
    "status.serviceNotRunning": "\nService:  ⚠  Installed but not running",
    "status.serviceFile": (path) => `  Service file : ${path}`,
    "status.serviceStart": (command) => `  Start : ${command}`,
    "status.serviceUnsupported": (platform) => `\nService:  -  Unsupported on platform ${platform}`,
    // set-token
    "setToken.noPairing": "No pairing config found. Run 'clawconnect pair' first.",
    "setToken.whereToFind": "\nWhere to find your Gateway Token:",
    "setToken.option1": "  Option 1 — OpenClaw desktop app: Settings → Advanced → Gateway Token",
    "setToken.option2": "  Option 2 — Terminal:",
    "setToken.option2cmd": "    cat ~/.openclaw/openclaw.json | grep -A2 'auth'",
    "setToken.option3": "  Option 3 — If set via environment variable: echo $OPENCLAW_GATEWAY_TOKEN\n",
    "setToken.prompt": "Gateway Token (leave blank to clear): ",
    "setToken.saved": "\nToken saved to ~/.clawconnect/config.json.",
    "setToken.cleared": "\nToken cleared from ~/.clawconnect/config.json.",
    "setToken.restart": "Run 'clawconnect restart' to apply the change.\n",
};
const zh = {
    // pair
    "pair.alreadyRegistered": (id) => `网关已注册 (id=${id})，正在刷新访问码…`,
    "pair.invalidCredentials": "凭证无效 (401)，服务器无法识别此网关。\n请运行 `clawconnect reset` 清除配置后重新注册。",
    "pair.invalidCredentialsWithCommands": (resetCommand, pairCommand) => `凭证无效 (401)，服务器无法识别此网关。\n请运行 \`${resetCommand}\` 清除此 profile 配置，然后运行 \`${pairCommand}\` 重新注册。`,
    "pair.refreshFailed": (status, body) => `刷新访问码失败：${status} ${body}`,
    "pair.registering": "正在向中继服务器注册…",
    "pair.registrationFailed": (status, body) => `注册失败：${status} ${body}`,
    "pair.registered": (id) => `注册成功！网关 ID：${id}`,
    "pair.scanQR": "\n请用 ClawConnect 移动应用扫描此二维码：\n",
    "pair.accessCode": (code) => `\n访问码（一次性使用）：${code}`,
    "pair.installingService": "\n正在安装/更新中继后台服务…",
    // run
    "run.starting": "正在启动 ClawConnect 主机代理…",
    "run.gatewayId": (id) => `  网关 ID：    ${id}`,
    "run.relayServer": (url) => `  中继服务器：${url}`,
    "run.gatewayUrl": (url) => `  网关地址：  ${url}`,
    "run.connected": "中继已连接。",
    "run.disconnected": "中继已断开，正在重连…",
    "run.retry": (attempt, delay) => `第 ${attempt} 次重试，等待 ${delay}ms…`,
    // install
    "install.serviceStarted": (manager) => `服务已通过 ${manager} 安装并启动。`,
    "install.installFailed": (manager) => `通过 ${manager} 启动服务失败。`,
    "install.serviceFileWritten": (path) => `服务文件已写入：${path}`,
    "install.startManually": (command) => `请手动运行：${command}`,
    "install.restarting": "正在重启中继服务…",
    "install.serviceRestarted": (manager) => `服务已通过 ${manager} 重启。`,
    "install.restartFailed": (manager) => `通过 ${manager} 重启服务失败。`,
    "install.stopped": (manager) => `已通过 ${manager} 停止中继客户端。`,
    "install.stoppedAndRemoved": (manager) => `中继客户端已停止并从 ${manager} 移除。`,
    "install.noService": "未找到正在运行的中继服务。",
    "install.unsupported": (platform) => `当前平台 ${platform} 暂不支持后台服务管理`,
    "install.runForeground": "请改用 `clawconnect run` 前台运行。",
    "install.configRemoved": (path) => `配置文件已删除：${path}`,
    "install.removeConfigFailed": "删除配置文件失败：",
    "install.noConfig": "未找到配置文件。",
    "install.resetComplete": "\n重置完成。请运行 `clawconnect pair` 重新注册。",
    "install.resetCompleteWithCommand": (command) => `\n重置完成。请运行 \`${command}\` 重新注册。`,
    // update
    "update.localInstallWarning": "检测到当前是本地源码目录运行。`clawconnect update` 只会升级全局 npm 安装的版本。",
    "update.activePath": (path) => `当前命中的 CLI 路径：${path}`,
    "update.currentVersion": (version) => `当前 CLI 版本：${version}`,
    "update.targetVersion": (version) => `目标 npm 版本：${version}`,
    "update.starting": (pkg) => `正在升级 ${pkg}…`,
    "update.updated": (pkg) => `${pkg} 已升级成功。`,
    "update.failed": (pkg) => `升级 ${pkg} 失败。`,
    "update.verifyFailed": "升级命令已执行，但无法校验当前生效的 CLI 路径或版本。",
    "update.versionMismatch": (expected, actual) => `升级执行完成，但当前生效的 CLI 仍然是 ${actual}，不是目标版本 ${expected}。`,
    "update.pathMismatchHint": (path) => `当前 PATH 解析到的 \`clawconnect\` 路径是：${path}`,
    "update.reinstallingService": "正在用当前生效的 CLI 路径重装后台服务…",
    "update.restartingService": "正在重启后台服务以加载新版本…",
    "update.serviceReinstalled": (manager) => `后台服务已通过 ${manager} 刷新。`,
    "update.serviceReinstallFailed": (manager) => `升级成功，但通过 ${manager} 刷新后台服务失败。正在回退到重启…`,
    "update.serviceRestarted": (manager) => `后台服务已通过 ${manager} 重启。`,
    "update.serviceRestartFailed": (manager) => `升级成功，但通过 ${manager} 重启后台服务失败。`,
    "update.noServiceRestartNeeded": "未检测到已安装的后台服务。下次运行 `clawconnect` 时会使用新版本。",
    "update.manualHint": (command) => `请手动运行：${command}`,
    // status
    "status.title": "── ClawConnect 主机代理状态 ──\n",
    "status.notPaired": "配置：✗  未配对 — 请先运行 'clawconnect pair'",
    "status.paired": "配置：✓  已配对",
    "status.displayName": (name) => `  显示名称：${name}`,
    "status.gatewayId": (id) => `  网关 ID：  ${id}`,
    "status.gatewayType": (type) => `  网关类型：${type}`,
    "status.relayServer": (url) => `  中继服务器：${url}`,
    "status.configCorrupted": "配置：✗  文件存在但已损坏",
    "status.gateway": (url) => `\n网关地址：${url}`,
    "status.servicePlatform": (manager) => `\n服务管理器：${manager}`,
    "status.serviceNotInstalled": "\n服务：✗  未安装 — 请运行 'clawconnect install'",
    "status.serviceRunning": (manager) => `\n服务：✓  运行中 (${manager})`,
    "status.serviceLog": (path) => `  日志：${path}`,
    "status.relayHealth": (icon, detail) => `  中继连接：${icon}  ${detail}`,
    "status.gatewayHealth": (icon, detail) => `  网关连接：${icon}  ${detail}`,
    "status.agentHealth": (icon, detail) => `  代理连接：${icon}  ${detail}`,
    "status.serviceNotRunning": "\n服务：⚠  已安装但未运行",
    "status.serviceFile": (path) => `  服务文件：${path}`,
    "status.serviceStart": (command) => `  启动命令：${command}`,
    "status.serviceUnsupported": (platform) => `\n服务：-  平台 ${platform} 暂不支持`,
    // set-token
    "setToken.noPairing": "未找到配对配置，请先运行 'clawconnect pair'。",
    "setToken.whereToFind": "\n如何查找 Gateway Token：",
    "setToken.option1": "  方式一 — OpenClaw 桌面应用：设置 → 高级 → Gateway Token",
    "setToken.option2": "  方式二 — 终端：",
    "setToken.option2cmd": "    cat ~/.openclaw/openclaw.json | grep -A2 'auth'",
    "setToken.option3": "  方式三 — 若通过环境变量设置：echo $OPENCLAW_GATEWAY_TOKEN\n",
    "setToken.prompt": "Gateway Token（留空则清除）：",
    "setToken.saved": "\nToken 已保存到 ~/.clawconnect/config.json。",
    "setToken.cleared": "\nToken 已从 ~/.clawconnect/config.json 清除。",
    "setToken.restart": "请运行 'clawconnect restart' 使修改生效。\n",
};
function detectLocale() {
    const lang = process.env.LANG ?? process.env.LC_ALL ?? process.env.LANGUAGE ?? "";
    if (lang.toLowerCase().startsWith("zh"))
        return "zh";
    // Windows: LANG/LC_ALL are rarely set — query the system locale via PowerShell
    if (process.platform === "win32") {
        try {
            const locale = execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Culture).Name"], { stdio: "pipe", timeout: 3000 })
                .toString()
                .trim()
                .toLowerCase();
            if (locale.startsWith("zh"))
                return "zh";
        }
        catch {
            // Non-fatal: fall back to English
        }
    }
    return "en";
}
const locale = detectLocale();
const msgs = locale === "zh" ? zh : en;
export function t(key, ...args) {
    const val = msgs[key] ?? en[key] ?? key;
    if (typeof val === "function")
        return val(...args);
    return val;
}
//# sourceMappingURL=index.js.map