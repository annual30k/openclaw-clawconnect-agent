import {
  runHermesAsync,
  runHermesPythonAsync,
} from "./hermes-runtime-process.js";
import { parseHermesSkillsList } from "./hermes-runtime-skills.js";
import { stringValue, toRecord } from "./hermes-runtime-values.js";

const HERMES_FILE_TRANSFER_SKILL = "file-transfer";
const HERMES_SKILLS_LIST_TIMEOUT_MS = 5_000;
const HERMES_SKILL_PROMPT_TIMEOUT_MS = 10_000;

export type HermesPreloadedSkillContext = {
  cliArgs: string[];
  requiredToolsets: string[];
  skillNames: string[];
};

export async function resolveHermesPreloadedSkillContext(): Promise<HermesPreloadedSkillContext> {
  try {
    const output = await runHermesAsync(["skills", "list"], HERMES_SKILLS_LIST_TIMEOUT_MS);
    const skills = parseHermesSkillsList(output);
    const fileTransfer = skills.find((skill) => skill.skillKey === HERMES_FILE_TRANSFER_SKILL);
    if (fileTransfer && fileTransfer.enabled !== false) {
      return {
        cliArgs: ["--skills", HERMES_FILE_TRANSFER_SKILL],
        requiredToolsets: ["terminal"],
        skillNames: [HERMES_FILE_TRANSFER_SKILL],
      };
    }
  } catch {
    // Hermes without skills support should still be able to answer normal chat.
  }
  return { cliArgs: [], requiredToolsets: [], skillNames: [] };
}

export async function buildHermesPreloadedSkillsPrompt(
  skillNames: string[],
  taskId?: string,
): Promise<string | undefined> {
  const normalizedSkillNames = skillNames
    .map((skillName) => skillName.trim())
    .filter((skillName) => skillName.length > 0);
  if (normalizedSkillNames.length === 0) {
    return undefined;
  }
  const script = [
    "import json",
    "from agent.skill_commands import build_preloaded_skills_prompt",
    `skill_names = ${JSON.stringify(normalizedSkillNames)}`,
    `task_id = ${taskId ? JSON.stringify(taskId) : "None"}`,
    "prompt, loaded, missing = build_preloaded_skills_prompt(skill_names, task_id=task_id)",
    "print(json.dumps({'prompt': prompt, 'loaded': loaded, 'missing': missing}, ensure_ascii=False))",
  ].join("\n");
  try {
    const raw = await runHermesPythonAsync(script, {}, HERMES_SKILL_PROMPT_TIMEOUT_MS);
    const payload = toRecord(JSON.parse(raw.trim()));
    const missing = stringArrayValue(payload.missing);
    const prompt = stringValue(payload.prompt);
    // 这里必须保守：API 路径只有拿到 Hermes 自己生成的完整 skill prompt 才能替代 CLI --skills。
    if (missing.length > 0 || !prompt) {
      return undefined;
    }
    return prompt;
  } catch {
    return undefined;
  }
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
