
import type { LocalCommandContext, LocalResult } from "../../commands/local-runtime.js";
import { runHermesOutput } from "./hermes-runtime-command-utils.js";
import {
  runHermesBackupCreate,
  runHermesBackupDelete,
  runHermesBackupList,
  runHermesBackupRestore,
} from "./hermes-runtime-backups.js";
import {
  runHermesCronCreate,
  runHermesCronList,
  runHermesCronRemove,
  runHermesCronRun,
  runHermesCronUpdate,
} from "./hermes-runtime-cron.js";
import { runHermesLifecycle } from "./hermes-runtime-lifecycle.js";
import { runHermesModelList, runHermesModelSelect } from "./hermes-runtime-models.js";
import { runHermesLogs } from "./hermes-runtime-command-utils.js";
import {
  runHermesDashboardStart,
  runHermesMcpAdd,
  runHermesMcpList,
  runHermesMcpRemove,
  runHermesMcpTest,
  runHermesSkillsInspect,
  runHermesSkillsInstall,
  runHermesSkillsList,
  runHermesSkillsSearch,
  runHermesSkillsUninstall,
  runHermesSkillsUpdate,
} from "./hermes-runtime-skills.js";
import {
  runHermesSessionDelete,
  runHermesSessionExport,
  runHermesSessionRename,
  runHermesSessionsList,
} from "./hermes-runtime-sessions.js";

export function handleHermesCommand(
  method: string,
  params: unknown,
  context: LocalCommandContext = {},
): LocalResult | Promise<LocalResult> | null {
  switch (method) {
    case "hermes.status":
      return runHermesOutput(["status"]);
    case "hermes.logs":
      return runHermesLogs(params);
    case "hermes.sessions.list":
      return runHermesSessionsList();
    case "hermes.sessions.rename":
      return runHermesSessionRename(params);
    case "hermes.sessions.delete":
      return runHermesSessionDelete(params);
    case "hermes.sessions.export":
      return runHermesSessionExport(params);
    case "cron.list":
    case "hermes.cron.list":
      return runHermesCronList(params);
    case "cron.add":
    case "hermes.cron.add":
      return runHermesCronCreate(params);
    case "cron.update":
    case "hermes.cron.update":
      return runHermesCronUpdate(params);
    case "cron.remove":
    case "hermes.cron.remove":
      return runHermesCronRemove(params);
    case "cron.status":
    case "hermes.cron.status":
      return runHermesOutput(["cron", "status"]);
    case "hermes.cron.run":
      return runHermesCronRun(params);
    case "hermes.skills.list":
    case "skills.status":
      return runHermesSkillsList();
    case "hermes.skills.update":
      return runHermesSkillsUpdate(params);
    case "hermes.skills.search":
      return runHermesSkillsSearch(params);
    case "hermes.skills.inspect":
      return runHermesSkillsInspect(params);
    case "hermes.skills.install":
      return runHermesSkillsInstall(params);
    case "hermes.skills.uninstall":
      return runHermesSkillsUninstall(params);
    case "hermes.model.list":
      return runHermesModelList();
    case "hermes.model.select":
    case "hermes.model.setDefault":
      return runHermesModelSelect(params);
    case "hermes.mcp.list":
      return runHermesMcpList();
    case "hermes.mcp.test":
      return runHermesMcpTest(params);
    case "hermes.mcp.add":
      return runHermesMcpAdd(params);
    case "hermes.mcp.remove":
      return runHermesMcpRemove(params);
    case "hermes.dashboard.status":
      return runHermesOutput(["dashboard", "--status"]);
    case "hermes.dashboard.start":
      return runHermesDashboardStart(params);
    case "hermes.dashboard.stop":
      return runHermesOutput(["dashboard", "--stop"]);
    case "hermes.gateway.start":
      return runHermesLifecycle("start", context);
    case "hermes.gateway.stop":
      return runHermesLifecycle("stop", context);
    case "hermes.gateway.restart":
    case "hermes.agent.restart":
      return runHermesLifecycle("restart", context);
    case "hermes.backup.create":
      return runHermesBackupCreate(params);
    case "hermes.backup.list":
      return runHermesBackupList();
    case "hermes.backup.delete":
      return runHermesBackupDelete(params);
    case "hermes.backup.restore":
      return runHermesBackupRestore(params);
    case "hermes.update":
      return runHermesOutput(["update"], 10 * 60_000);
    default:
      return null;
  }
}
