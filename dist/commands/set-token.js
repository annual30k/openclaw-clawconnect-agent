import readline from "readline";
import { getConfigPath, readConfig, writeConfig } from "../config/config.js";
import { getActiveProfile } from "../config/profile.js";
import { t } from "../i18n/index.js";
import { resolveOpenClawConfigPath } from "../openclaw/runtime/openclaw-paths.js";
import { pairCommandForProfile, restartCommandForProfile } from "./profile-hints.js";
export async function setTokenCommand() {
    const activeProfile = getActiveProfile();
    const pairCommand = activeProfile ? pairCommandForProfile(activeProfile) : "clawconnect pair-openclaw";
    // Require pairing to be done first
    let config;
    try {
        config = readConfig();
    }
    catch {
        console.error(t("setToken.noPairingWithCommand", pairCommand));
        process.exit(1);
    }
    // Tell the user where to find the token
    console.log(t("setToken.whereToFind"));
    console.log(t("setToken.option1"));
    console.log(t("setToken.option2"));
    console.log(t("setToken.option2path", resolveOpenClawConfigPath()));
    console.log(t("setToken.option3"));
    // Prompt for the token
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const token = await new Promise((resolve) => {
        rl.question(t("setToken.prompt"), (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
    const configPath = getConfigPath();
    // Save
    if (token) {
        config.gatewayToken = token;
        delete config.gatewayPassword;
        writeConfig(config);
        console.log(t("setToken.savedAt", configPath));
    }
    else {
        delete config.gatewayToken;
        delete config.gatewayPassword;
        writeConfig(config);
        console.log(t("setToken.clearedAt", configPath));
    }
    console.log(t("setToken.restartWithCommand", restartCommandForProfile(activeProfile)));
}
//# sourceMappingURL=set-token.js.map