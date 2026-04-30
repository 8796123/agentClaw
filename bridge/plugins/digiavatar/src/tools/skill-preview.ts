// src/tools/skillInstructions.ts
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { IncomingMessage } from "node:http";
import { join } from "path";
import os from "os";
import type Database from "better-sqlite3";
import { acquireDb, releaseDb, DbInitializer } from "../db.js";


function getDatabasePath(agentDir: string): string {
  return join(agentDir, "digiavatar.db");
}

export const initDigiavatarSchema: DbInitializer = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS train_preview (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT UNIQUE,
      name TEXT,
      description TEXT,
      instructions TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_train_preview_sessionId ON train_preview(sessionId);
  `);
};

export function registerSkillInstructionsTool(api: OpenClawPluginApi | any) {
  api.registerTool(
    (ctx: any) => ({
      name: "set-skill-instructions",
      description:
        "在与用户持续沟通的过程中，通过“每次全量覆盖”的方式维护 instructions 的内容",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          instructions: {
            type: "string",
            description: "技能说明书，内容使用 **Markdown** 表达结构",
          },
        },
        required: ["instructions"],
      },
      execute: async (_toolCallId: string, p: { instructions: string }) => {
        const sessionId = ctx?.sessionId ?? "unknown-session";
        const agentDir =
          ctx?.agentDir ?? join(os.homedir(), ".openclaw/agents/main/agent");

        const dbPath = getDatabasePath(agentDir);
        const db = await acquireDb(dbPath, {
          pragmas: ["journal_mode = WAL"],
          initializer: initDigiavatarSchema,
        });

        try {
          db.prepare(
            `INSERT INTO train_preview (sessionId, instructions)
             VALUES (?, ?)
             ON CONFLICT(sessionId) DO UPDATE SET
               instructions = excluded.instructions`
          ).run(sessionId, p.instructions);

          return db
            .prepare(`SELECT name, description, instructions FROM train_preview WHERE sessionId = ?`)
            .get(sessionId);
        } finally {
          await releaseDb(dbPath);
        }
      },
    }),
    { name: "set-skill-instructions" }
  );
}

export function registerSkillMetaTool(api: OpenClawPluginApi | any) {
  api.registerTool(
    (ctx: any) => ({
      name: "set-skill-name-description",
      description: "总结并提取当前技能的基础信息：名称与描述。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            description: "技能名称，5~20字，例如：'创建PDF'",
          },
          description: {
            type: "string",
            description: "技能说明，20~50字，例如：'根据传入的文本/图片/表格数据生成 PDF 文件，支持设置页面大小、边距、字体与页眉页脚；可选择保存到指定路径或返回字节流（bytes）便于网络传输与下载。'",
          },
        },
        required: ["name", "description"],
      },
      execute: async (
        _toolCallId: string,
        p: { name: string; description: string }
      ) => {
        const sessionId = ctx?.sessionId ?? "unknown-session";
        const agentDir =
          ctx?.agentDir ?? join(os.homedir(), ".openclaw/agents/main/agent");
        const dbPath = getDatabasePath(agentDir);
        const db = await acquireDb(dbPath, {
          pragmas: ["journal_mode = WAL"],
          initializer: initDigiavatarSchema,
        });
        try {
          db.prepare(
            `INSERT INTO train_preview (sessionId, name, description)
             VALUES (?, ?, ?)
             ON CONFLICT(sessionId) DO UPDATE SET
               name = excluded.name,
               description = excluded.description`
          ).run(sessionId, p.name, p.description);
          return db
            .prepare(`SELECT name, description, instructions FROM train_preview WHERE sessionId = ?`)
            .get(sessionId);
        } finally {
          await releaseDb(dbPath);
        }
      },
    }),
    { name: "set-skill-name-description" }
  );
}

function safeJsonStringify(x: any): string {
  try {
    return typeof x === "string" ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}

export function registerBeforePromptBuildHook(
  api: OpenClawPluginApi | any,
  opts?: { priority?: number }
) {
  const priority = opts?.priority ?? 10;
  api.on(
    "before_prompt_build",
    async (_event: any, ctx: any) => {
      const agentId = ctx?.agentId
      if (!agentId || !agentId.includes("digiavatar-training")) {
        return {};
      }

      const sessionId = ctx?.sessionId ?? "unknown-session";
      const agentDir = ctx?.agentDir ?? join(os.homedir(), ".openclaw/agents/main/agent");
      const dbPath = getDatabasePath(agentDir);
      const db = await acquireDb(dbPath, {
        pragmas: ["journal_mode = WAL"],
        initializer: initDigiavatarSchema,
      });
      try {
        const record =
          db.prepare(`SELECT name, description, instructions FROM train_preview WHERE sessionId = ?`).get(sessionId) ??
          null;
        if (!record) {
          return {};
        }
        return {
          appendSystemContext: `**最新技能记录**：${
            safeJsonStringify(record)
          }`,
        };
      } finally {
        await releaseDb(dbPath);
      }
    },
    { priority }
  );
}

function sendJson(res: any, statusCode: number, body: any) {
  res.statusCode = statusCode;
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function parseRequestBody(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let body = "";
    
    // 监听 data 事件，接收数据块
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    
    // 监听 end 事件，数据接收完成
    req.on("end", () => {
      try {
        if (!body) {
          resolve({});
          return;
        }
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (error) {
        reject(new Error("Invalid JSON in request body"));
      }
    });
    
    // 监听 error 事件，处理流错误
    req.on("error", (error) => {
      reject(error);
    });
  });
}

export function registerSkillPreviewRoute(api: OpenClawPluginApi | any) {
  api.registerHttpRoute({
    path: "/digiavatar/api/skill/preview",
    auth: "gateway",
    match: "exact",
    handler: async (req: any, res: any) => {
      try {
        // 只接受 POST 请求
        if (req.method !== "POST") {
          sendJson(res, 405, {
            error: "Method not allowed",
          });
          return true;
        }
        
        // 解析请求体
        const body = await parseRequestBody(req);
        console.log("req.body:", body);
        const agentId = body.agentId;
        console.log("agentId:", agentId);
        const sessionId = body.sessionId;
        console.log("sessionId:", sessionId);
        if (!sessionId || !agentId) {
          sendJson(res, 400, {
            error: `Missing sessionId or agentId. Use /digiavatar/api/skill/preview`,
          });
          return true;
        }
        
        // 查找指定的 agent 配置
        const agentConfig = api.config.agents?.list?.find((agent: any) => agent.id === agentId);
        
        if (!agentConfig) {
          sendJson(res, 404, {
            error: `Agent with ID "${agentId}" not found`,
          });
          return true;
        }
        
        // 获取 agent 目录
        const agentDir = agentConfig.agentDir;  
        if (!agentDir) {
          sendJson(res, 404, {
            error: `Agent directory not configured for agent "${agentId}"`,
          });
          return true;
        }

        const finalAgentDir = agentDir || join(os.homedir(), ".openclaw/agents/main/agent");
        const dbPath = getDatabasePath(finalAgentDir);
        const db = await acquireDb(dbPath, {
          pragmas: ["journal_mode = WAL"],
          initializer: initDigiavatarSchema,
        });
        try {
          const record =
            db
              .prepare(`SELECT name, description, instructions FROM train_preview WHERE sessionId = ?`)
              .get(sessionId) ?? null;
          sendJson(res, 200, record);
          return true;
        } finally {
          await releaseDb(dbPath);
        }
      } catch (e: any) {
        sendJson(res, 500, {
          error: e?.message ?? String(e),
        });
        return true;
      }
    },
  });
}

