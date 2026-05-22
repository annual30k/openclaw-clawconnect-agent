import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type SlashCommandDescriptor = {
  source: "OpenClaw";
  command: string;
  title: string;
  detail: string;
};

export type SlashCommandCatalogGenerationOptions = {
  openClawRegistryPath?: string;
  outputPath?: string;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const defaultOpenClawRegistryPath = resolve(
  repoRoot,
  "../../openclaw/src/auto-reply/commands-registry.shared.ts",
);
const defaultOutputPath = resolve(repoRoot, "src/relay/slash-command-catalog.generated.ts");
const REMOVED_OPENCLAW_SLASH_COMMANDS = new Set(["/tts"]);

function skipParentheses(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function readStringExpression(node: ts.Expression | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  const expression = skipParentheses(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }

  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const spanValue = readStringExpression(span.expression as ts.Expression);
      if (spanValue === undefined) {
        return undefined;
      }
      value += spanValue + span.literal.text;
    }
    return value;
  }

  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = readStringExpression(expression.left);
    const right = readStringExpression(expression.right);
    if (left === undefined || right === undefined) {
      return undefined;
    }
    return left + right;
  }

  return undefined;
}

function readStringArray(node: ts.Expression | undefined): string[] | undefined {
  if (!node) {
    return undefined;
  }
  const expression = skipParentheses(node);
  if (!ts.isArrayLiteralExpression(expression)) {
    return undefined;
  }

  const values: string[] = [];
  for (const element of expression.elements) {
    if (ts.isSpreadElement(element)) {
      return undefined;
    }
    const value = readStringExpression(element as ts.Expression);
    if (value === undefined) {
      return undefined;
    }
    values.push(value);
  }
  return values;
}

function getProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) {
      continue;
    }
    const propertyName = property.name.getText();
    if (propertyName === name) {
      return property;
    }
  }
  return undefined;
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeTitle(command: string): string {
  return normalizeCommand(command).replace(/^\/+/, "").replace(/[-_]+/g, " ");
}

function extractOpenClawBuiltinCommands(sourceText: string): SlashCommandDescriptor[] {
  const sourceFile = ts.createSourceFile(
    "commands-registry.shared.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const buildBuiltin = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "buildBuiltinChatCommands",
  );

  if (!buildBuiltin?.body) {
    throw new Error("Could not find buildBuiltinChatCommands() in commands-registry.shared.ts");
  }

  const commandsVariable = buildBuiltin.body.statements.find((statement): statement is ts.VariableStatement => {
    if (!ts.isVariableStatement(statement)) {
      return false;
    }
    return statement.declarationList.declarations.some((declaration) => {
      return ts.isIdentifier(declaration.name) && declaration.name.text === "commands";
    });
  });

  if (!commandsVariable) {
    throw new Error("Could not find commands array in buildBuiltinChatCommands()");
  }

  const commandsDeclaration = commandsVariable.declarationList.declarations.find(
    (declaration): declaration is ts.VariableDeclaration =>
      ts.isIdentifier(declaration.name) && declaration.name.text === "commands",
  );

  const initializer = commandsDeclaration?.initializer;
  if (!initializer || !ts.isArrayLiteralExpression(skipParentheses(initializer as ts.Expression))) {
    throw new Error("Could not find builtin command array literal");
  }

  const arrayLiteral = skipParentheses(initializer as ts.Expression) as ts.ArrayLiteralExpression;
  const descriptors: SlashCommandDescriptor[] = [];
  const seen = new Set<string>();

  for (const element of arrayLiteral.elements) {
    if (!ts.isCallExpression(element)) {
      continue;
    }
    if (!ts.isIdentifier(element.expression) || element.expression.text !== "defineChatCommand") {
      continue;
    }

    const definition = element.arguments[0];
    if (!definition || !ts.isObjectLiteralExpression(definition)) {
      throw new Error("defineChatCommand() must be called with an object literal in buildBuiltinChatCommands()");
    }

    const description = readStringExpression(getProperty(definition, "description")?.initializer);
    if (!description) {
      throw new Error("Missing description in OpenClaw builtin command definition");
    }

    const aliases =
      readStringArray(getProperty(definition, "textAliases")?.initializer) ??
      (() => {
        const alias = readStringExpression(getProperty(definition, "textAlias")?.initializer);
        return alias ? [alias] : undefined;
      })();

    if (!aliases || aliases.length === 0) {
      continue;
    }

    for (const alias of aliases) {
      const command = normalizeCommand(alias);
      const commandKey = command.toLowerCase();
      if (REMOVED_OPENCLAW_SLASH_COMMANDS.has(commandKey)) {
        continue;
      }
      if (seen.has(commandKey)) {
        continue;
      }
      seen.add(commandKey);
      descriptors.push({
        source: "OpenClaw",
        command,
        title: normalizeTitle(command),
        detail: normalizeCommand(description),
      });
    }
  }

  return descriptors;
}

export function loadOpenClawSlashCommandCatalog(
  options: SlashCommandCatalogGenerationOptions = {},
): SlashCommandDescriptor[] {
  const openClawRegistryPath = options.openClawRegistryPath ?? defaultOpenClawRegistryPath;
  const sourceText = readFileSync(openClawRegistryPath, "utf8");
  return extractOpenClawBuiltinCommands(sourceText);
}

export function renderOpenClawSlashCommandCatalogSource(commands: readonly SlashCommandDescriptor[]): string {
  const serializedEntries = commands
    .map(
      (command) => `  {
    source: ${JSON.stringify(command.source)},
    command: ${JSON.stringify(command.command)},
    title: ${JSON.stringify(command.title)},
    detail: ${JSON.stringify(command.detail)},
  },`,
    )
    .join("\n");

  return `// This file is generated by scripts/sync-slash-command-catalog.ts from
// openclaw/src/auto-reply/commands-registry.shared.ts. Do not edit by hand.

export const OPENCLAW_SLASH_COMMAND_CATALOG = [
${serializedEntries}
] as const;
`;
}

export function writeOpenClawSlashCommandCatalog(options: SlashCommandCatalogGenerationOptions = {}): {
  outputPath: string;
  commands: SlashCommandDescriptor[];
} {
  const outputPath = options.outputPath ?? defaultOutputPath;
  const commands = loadOpenClawSlashCommandCatalog(options);
  const rendered = renderOpenClawSlashCommandCatalogSource(commands);
  writeFileSync(outputPath, rendered, "utf8");
  return { outputPath, commands };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = writeOpenClawSlashCommandCatalog();
  console.log(`Wrote ${result.commands.length} OpenClaw slash commands to ${result.outputPath}`);
}
