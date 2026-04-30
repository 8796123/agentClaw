// index.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerSkillInstructionsTool, registerSkillMetaTool, registerBeforePromptBuildHook, registerSkillPreviewRoute } from "./src/tools/skill-preview.js"; 


export default function register(api: OpenClawPluginApi | any) {
  registerSkillInstructionsTool(api);
  registerSkillMetaTool(api);
  registerBeforePromptBuildHook(api, { priority: 10 });
  registerSkillPreviewRoute(api);
}
