import { LocalCommandContext, LocalResult } from "./local-runtime.js";
export declare function handleLocalCommand(method: string, params?: unknown, context?: LocalCommandContext): LocalResult | Promise<LocalResult> | null;
