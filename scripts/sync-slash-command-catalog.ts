import { writeOpenClawSlashCommandCatalog } from "./slash-command-catalog-generator.js";

const result = writeOpenClawSlashCommandCatalog();
console.log(`Synced ${result.commands.length} slash commands to ${result.outputPath}`);
