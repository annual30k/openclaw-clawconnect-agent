import readline from "readline";
import { readConfig, writeConfig } from "../config/config.js";
import { t } from "../i18n/index.js";

export async function setTokenCommand(): Promise<void> {
  // Require pairing to be done first
  let config;
  try {
    config = readConfig();
  } catch {
    console.error(t("setToken.noPairing"));
    process.exit(1);
  }

  // Tell the user where to find the token
  console.log(t("setToken.whereToFind"));
  console.log(t("setToken.option1"));
  console.log(t("setToken.option2"));
  console.log(t("setToken.option2cmd"));
  console.log(t("setToken.option3"));

  // Prompt for the token
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const token = await new Promise<string>((resolve) => {
    rl.question(t("setToken.prompt"), (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  // Save
  if (token) {
    config.gatewayToken = token;
    delete config.gatewayPassword;
    writeConfig(config);
    console.log(t("setToken.saved"));
  } else {
    delete config.gatewayToken;
    delete config.gatewayPassword;
    writeConfig(config);
    console.log(t("setToken.cleared"));
  }

  console.log(t("setToken.restart"));
}
