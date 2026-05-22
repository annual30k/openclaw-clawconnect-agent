
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import type { LocalResult } from "../../commands/local-runtime.js";
import {
  DEFAULT_TIMEOUT_MS,
  HERMES_HOME_DIR,
  runHermes,
  runHermesPython,
  runHermesWithInput,
} from "./hermes-runtime-process.js";
import { runHermesOutput } from "./hermes-runtime-command-utils.js";
import {
  numberParam,
  stringParam,
  stringValue,
  toRecord,
} from "./hermes-runtime-values.js";

export function runHermesSkillsList(): LocalResult {
  const output = runHermes(["skills", "list"]);
  return { ok: true, payload: { skills: parseHermesSkillsList(output), output } };
}

export function runHermesSkillsUpdate(params: unknown): LocalResult {
  const record = toRecord(params);
  const skillKey = stringParam(record, "skillKey", "name", "id");
  if (!skillKey || typeof record.enabled !== "boolean") {
    return { ok: false, error: "skill_key_and_enabled_required" };
  }
  const script = [
    "from hermes_cli.config import load_config",
    "from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills",
    `skill=${JSON.stringify(skillKey)}`,
    `enabled=${record.enabled ? "True" : "False"}`,
    "config=load_config()",
    "disabled=get_disabled_skills(config)",
    "disabled.discard(skill) if enabled else disabled.add(skill)",
    "save_disabled_skills(config, disabled)",
    "print('ok')",
  ].join("\n");
  runHermesPython(script);
  return { ok: true, payload: { ok: true, skillKey, enabled: record.enabled } };
}

export function runHermesSkillsSearch(params: unknown): LocalResult {
  const query = stringParam(toRecord(params), "query", "q") ?? "";
  return runHermesOutput(["skills", "search", query]);
}

export function runHermesSkillsInspect(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "identifier", "skillKey", "name", "id");
  if (!id) return { ok: false, error: "skill_identifier_required" };
  return runHermesOutput(["skills", "inspect", id]);
}

export function runHermesSkillsInstall(params: unknown): LocalResult {
  const record = toRecord(params);
  const id = stringParam(record, "identifier", "skillKey", "name", "id");
  if (!id) return { ok: false, error: "skill_identifier_required" };
  const args = ["skills", "install", id, "--yes"];
  const category = stringParam(record, "category");
  const name = stringParam(record, "nameOverride");
  if (category) args.push("--category", category);
  if (name) args.push("--name", name);
  if (record.force === true) args.push("--force");
  return runHermesOutput(args, 10 * 60_000);
}

export function runHermesSkillsUninstall(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "skillKey", "name", "id");
  if (!id) return { ok: false, error: "skill_name_required" };
  return runHermesOutput(["skills", "uninstall", id], 10 * 60_000);
}

export function runHermesMcpList(): LocalResult {
  const output = runHermes(["mcp", "list"]);
  return { ok: true, payload: { servers: parseHermesMcpList(output), output } };
}

export function runHermesMcpTest(params: unknown): LocalResult {
  const name = stringParam(toRecord(params), "name", "serverName");
  if (!name) return { ok: false, error: "mcp_server_name_required" };
  return runHermesOutput(["mcp", "test", name]);
}

export function runHermesMcpAdd(params: unknown): LocalResult {
  const record = toRecord(params);
  const name = stringParam(record, "name", "serverName");
  if (!name) return { ok: false, error: "mcp_server_name_required" };
  const args = ["mcp", "add", name];
  const url = stringParam(record, "url");
  const command = stringParam(record, "command");
  const preset = stringParam(record, "preset");
  if (url) args.push("--url", url);
  if (command) args.push("--command", command);
  const argValues = Array.isArray(record.args) ? record.args.filter((item): item is string => typeof item === "string") : [];
  if (argValues.length > 0) args.push("--args", ...argValues);
  if (preset) args.push("--preset", preset);
  const envValues = Array.isArray(record.env) ? record.env.filter((item): item is string => typeof item === "string") : [];
  if (envValues.length > 0) args.push("--env", ...envValues);
  const output = runHermesWithInput(args, "y\n", 10 * 60_000);
  return { ok: true, payload: { output } };
}

export function runHermesMcpRemove(params: unknown): LocalResult {
  const name = stringParam(toRecord(params), "name", "serverName");
  if (!name) return { ok: false, error: "mcp_server_name_required" };
  return { ok: true, payload: { output: runHermesWithInput(["mcp", "remove", name], "y\n", DEFAULT_TIMEOUT_MS) } };
}

export function runHermesDashboardStart(params: unknown): LocalResult {
  const record = toRecord(params);
  const args = ["dashboard", "--no-open"];
  const port = numberParam(record, "port");
  const host = stringParam(record, "host");
  if (port) args.push("--port", String(port));
  if (host) args.push("--host", host);
  if (record.tui === true) args.push("--tui");
  if (record.skipBuild === true) args.push("--skip-build");
  return runHermesOutput(args, 10 * 60_000);
}

export function parseHermesSkillsList(output: string): Array<Record<string, unknown>> {
  const skills: Array<Record<string, unknown>> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("│")) continue;
    const cells = line.split("│").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5 || cells[0] === "Name" || cells.some((cell) => cell.includes("━"))) continue;
    const skillKey = cells[0];
    const metadata = readHermesSkillMetadata(skillKey, cells[1]);
    skills.push({
      skillKey: metadata?.skillKey ?? skillKey,
      name: metadata?.name ?? skillKey,
      description: metadata?.description ?? cells[1],
      category: metadata?.category ?? cells[1],
      source: cells[2],
      trust: cells[3],
      status: cells[4],
      enabled: cells[4].toLowerCase() === "enabled",
      ...(metadata?.filePath ? { filePath: metadata.filePath } : {}),
      ...(metadata?.baseDir ? { baseDir: metadata.baseDir } : {}),
      ...(metadata?.homepage ? { homepage: metadata.homepage } : {}),
      ...(metadata?.requirements ? { requirements: metadata.requirements } : {}),
      ...(metadata?.platforms ? { platforms: metadata.platforms } : {}),
      ...(metadata?.version ? { version: metadata.version } : {}),
      ...(metadata?.author ? { author: metadata.author } : {}),
    });
  }
  return skills;
}

type HermesSkillMetadata = {
  skillKey: string;
  name: string;
  description?: string;
  category?: string;
  filePath?: string;
  baseDir?: string;
  homepage?: string;
  requirements?: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  platforms?: string[];
  version?: string;
  author?: string;
};

function readHermesSkillMetadata(skillKey: string, category: string): HermesSkillMetadata | undefined {
  const skillFile = resolveHermesSkillFile(skillKey, category);
  if (!skillFile) {
    return undefined;
  }
  try {
    const frontmatter = parseYamlFrontmatter(readFileSync(skillFile, "utf8"));
    const metadata = toRecord(frontmatter.metadata);
    const hermes = toRecord(metadata.hermes);
    return {
      skillKey: stringValue(frontmatter.name) ?? basename(dirnameForFile(skillFile)),
      name: stringValue(frontmatter.name) ?? basename(dirnameForFile(skillFile)),
      description: stringValue(frontmatter.description),
      category: normalizeSkillCategoryFromPath(skillFile),
      filePath: skillFile,
      baseDir: dirnameForFile(skillFile),
      homepage: stringValue(hermes.homepage) ?? stringValue(frontmatter.homepage),
      requirements: {
        bins: stringArrayValue(toRecord(frontmatter.prerequisites).commands),
        anyBins: [],
        env: [
          ...stringArrayValue(toRecord(frontmatter.prerequisites).env_vars),
          ...stringArrayValue(toRecord(frontmatter.prerequisites).env),
        ],
        config: stringArrayValue(toRecord(frontmatter.prerequisites).config),
        os: stringArrayValue(frontmatter.platforms),
      },
      platforms: stringArrayValue(frontmatter.platforms),
      version: stringValue(frontmatter.version),
      author: stringValue(frontmatter.author),
    };
  } catch {
    return undefined;
  }
}

function resolveHermesSkillFile(skillKey: string, category: string): string | undefined {
  const skillsDir = hermesSkillsDir();
  const candidates: string[] = [];
  if (category.trim()) {
    candidates.push(join(skillsDir, category.trim(), skillKey, "SKILL.md"));
  }
  candidates.push(join(skillsDir, skillKey, "SKILL.md"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const normalizedPrefix = skillKey.replace(/…+$/u, "").trim();
  if (!normalizedPrefix) {
    return undefined;
  }
  const categoryDirs = category.trim()
    ? [join(skillsDir, category.trim())]
    : [skillsDir, ...listDirectoryPaths(skillsDir)];
  for (const categoryDir of categoryDirs) {
    for (const skillDir of listDirectoryPaths(categoryDir)) {
      const name = basename(skillDir);
      if (name.startsWith(normalizedPrefix)) {
        const skillFile = join(skillDir, "SKILL.md");
        if (existsSync(skillFile)) {
          return skillFile;
        }
      }
    }
  }
  return undefined;
}

function parseYamlFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; record: Record<string, unknown> }> = [{ indent: -1, record: root }];
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const pair = rawLine.trim().match(/^([^:#][^:]*):(?:\s*(.*))?$/);
    if (!pair) {
      continue;
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].record;
    const key = pair[1].trim();
    const rawValue = pair[2]?.trim() ?? "";
    if (!rawValue) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, record: child });
    } else {
      parent[key] = parseYamlScalar(rawValue);
    }
  }
  return root;
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => stripYamlQuotes(item.trim())).filter(Boolean);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return stripYamlQuotes(trimmed);
}

function stripYamlQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function listDirectoryPaths(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function dirnameForFile(filePath: string): string {
  return filePath.slice(0, -"/SKILL.md".length);
}

function normalizeSkillCategoryFromPath(filePath: string): string | undefined {
  const skillsDir = hermesSkillsDir();
  const relative = filePath.startsWith(`${skillsDir}/`) ? filePath.slice(skillsDir.length + 1) : "";
  const parts = relative.split("/");
  const category = parts.length >= 3 ? parts[0]?.trim() : "";
  return category ? category : undefined;
}

function hermesSkillsDir(): string {
  return process.env.HERMES_SKILLS_DIR?.trim() || join(HERMES_HOME_DIR, "hermes-agent", "skills");
}

function parseHermesMcpList(output: string): Array<Record<string, unknown>> {
  if (/No MCP servers configured/i.test(output)) return [];
  const servers: Array<Record<string, unknown>> = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Name") || trimmed.startsWith("─") || trimmed.startsWith("MCP ")) continue;
    const match = trimmed.match(/^(\S+)\s+(.{1,30}?)\s{2,}(.{1,12}?)\s{2,}(.+)$/);
    if (match) {
      servers.push({ name: match[1], transport: match[2].trim(), tools: match[3].trim(), status: match[4].trim() });
    }
  }
  return servers;
}
