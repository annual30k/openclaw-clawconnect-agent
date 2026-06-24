import type { RelaySlashCommandDescriptor } from "../../core/relay/slash-command-types.js";
import { runHermesPython } from "../runtime/hermes-runtime-process.js";

const HERMES_SLASH_COMMAND_CATALOG_SCRIPT = String.raw`
import json

items = []

def add(command, title=None, detail=None):
    if not command:
        return
    command = str(command).strip()
    if not command:
        return
    if not command.startswith("/"):
        command = "/" + command
    title = str(title or command.lstrip("/") or command).strip()
    detail = str(detail or title or command).strip()
    items.append({"command": command, "title": title, "detail": detail})

try:
    from hermes_cli.commands import COMMANDS
    for command, detail in COMMANDS.items():
        add(command, command.lstrip("/"), detail)
except Exception:
    pass

try:
    from agent.skill_commands import get_skill_commands
    for command, info in get_skill_commands().items():
        if not isinstance(info, dict):
            info = {}
        add(command, info.get("name") or str(command).lstrip("/"), info.get("description") or "Skill command")
except Exception:
    pass

try:
    from hermes_cli.plugins import get_plugin_commands
    for command, info in get_plugin_commands().items():
        if not isinstance(info, dict):
            info = {}
        add(command, command, info.get("description") or "Plugin command")
except Exception:
    pass

print(json.dumps(items, ensure_ascii=False))
`;

type HermesSlashCommandRunner = (script: string) => string;
type HermesSlashCommandCollector = () => readonly RelaySlashCommandDescriptor[];

const DEFAULT_HERMES_SLASH_COMMAND_SEARCH_LIMIT = 16;
const MAX_HERMES_SLASH_COMMAND_SEARCH_LIMIT = 50;
const MAX_HERMES_SLASH_COMMAND_SEARCH_OFFSET = 10_000;
let hermesSlashCommandCatalogCache: RelaySlashCommandDescriptor[] | undefined;

export interface HermesSlashCommandSearchResult {
  items: RelaySlashCommandDescriptor[];
  hasMore: boolean;
  nextOffset?: number;
  total: number;
}

export function collectHermesSlashCommandCatalog(
  runPython: HermesSlashCommandRunner = runHermesPython,
): RelaySlashCommandDescriptor[] {
  try {
    return parseHermesSlashCommandCatalog(runPython(HERMES_SLASH_COMMAND_CATALOG_SCRIPT));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[hermes-relay] failed to load Hermes slash command catalog: ${message}`);
    return [];
  }
}

export function searchHermesSlashCommandCatalog(opts: {
  query?: unknown;
  limit?: unknown;
  offset?: unknown;
  collect?: HermesSlashCommandCollector;
} = {}): HermesSlashCommandSearchResult {
  const query = normalizeHermesSlashCommandQuery(opts.query);
  const limit = normalizeHermesSlashCommandSearchLimit(opts.limit);
  const offset = normalizeHermesSlashCommandSearchOffset(opts.offset);
  const catalog = [...(opts.collect ?? getCachedHermesSlashCommandCatalog)()];

  const matches = catalog
    .map((command, index) => {
      const rank = hermesSlashCommandMatchRank(command, query);
      return rank === undefined ? undefined : { command, index, rank };
    })
    .filter((entry): entry is { command: RelaySlashCommandDescriptor; index: number; rank: number } => entry !== undefined)
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (left.index !== right.index) return left.index - right.index;
      return left.command.title.localeCompare(right.command.title);
    });
  const items = matches.slice(offset, offset + limit).map((entry) => entry.command);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < matches.length;

  return {
    items,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
    total: matches.length,
  };
}

export function readHermesSlashCommandSearchParams(params: unknown): {
  query?: unknown;
  limit?: unknown;
  offset?: unknown;
} {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  const record = params as Record<string, unknown>;
  return {
    query: record.query,
    limit: record.limit,
    offset: record.offset,
  };
}

function parseHermesSlashCommandCatalog(rawOutput: string): RelaySlashCommandDescriptor[] {
  const rawValue = JSON.parse(rawOutput) as unknown;
  if (!Array.isArray(rawValue)) {
    return [];
  }

  const commands: RelaySlashCommandDescriptor[] = [];
  const seen = new Set<string>();

  for (const entry of rawValue) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const command = normalizeHermesSlashCommandText(record.command ?? record.name ?? record.value ?? record.text);
    if (!command) {
      continue;
    }

    const key = command.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const title = readHermesSlashCommandLabel(record.title ?? record.label ?? record.name) ?? command.replace(/^\//, "");
    const detail = readHermesSlashCommandLabel(record.detail ?? record.description ?? record.summary) ?? title;
    commands.push({
      source: "Hermes",
      command,
      title,
      detail,
    });
  }

  return commands;
}

function normalizeHermesSlashCommandText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function readHermesSlashCommandLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || undefined;
}

function getCachedHermesSlashCommandCatalog(): readonly RelaySlashCommandDescriptor[] {
  if (!hermesSlashCommandCatalogCache) {
    hermesSlashCommandCatalogCache = collectHermesSlashCommandCatalog();
  }
  return hermesSlashCommandCatalogCache;
}

function normalizeHermesSlashCommandQuery(value: unknown): string {
  if (typeof value !== "string") {
    return "/";
  }
  const trimmed = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeHermesSlashCommandSearchLimit(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_HERMES_SLASH_COMMAND_SEARCH_LIMIT, Math.trunc(value)));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(MAX_HERMES_SLASH_COMMAND_SEARCH_LIMIT, Math.trunc(parsed)));
    }
  }
  return DEFAULT_HERMES_SLASH_COMMAND_SEARCH_LIMIT;
}

function normalizeHermesSlashCommandSearchOffset(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(MAX_HERMES_SLASH_COMMAND_SEARCH_OFFSET, Math.trunc(value)));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(MAX_HERMES_SLASH_COMMAND_SEARCH_OFFSET, Math.trunc(parsed)));
    }
  }
  return 0;
}

// Hermes 命令分页必须稳定：优先匹配强度，其次保留宿主返回顺序，避免移动端分页跳动。
function hermesSlashCommandMatchRank(command: RelaySlashCommandDescriptor, query: string): number | undefined {
  const normalizedCommand = command.command.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalizedCommand) {
    return undefined;
  }
  if (query === "/") return 0;
  if (normalizedCommand === query) {
    return 0;
  }
  if (normalizedCommand.startsWith(query)) {
    return 1;
  }
  if (query.startsWith(normalizedCommand)) {
    return 2;
  }

  const compactCommand = compactSlashSearchText(normalizedCommand);
  const compactQuery = compactSlashSearchText(query);
  if (!compactQuery) return 0;
  if (compactCommand.includes(compactQuery)) {
    return 3;
  }
  if (isSubsequence(compactQuery, compactCommand)) {
    return 4;
  }

  const searchableText = [command.title, command.detail]
    .map((value) => compactSlashSearchText(value))
    .filter(Boolean)
    .join(" ");
  if (searchableText.includes(compactQuery)) {
    return 5;
  }
  if (isSubsequence(compactQuery, searchableText)) {
    return 6;
  }
  return undefined;
}

function compactSlashSearchText(value: string): string {
  return value
    .trim()
    .replace(/^\//, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let needleIndex = 0;
  for (const char of haystack) {
    if (char === needle[needleIndex]) {
      needleIndex += 1;
      if (needleIndex === needle.length) {
        return true;
      }
    }
  }
  return false;
}
