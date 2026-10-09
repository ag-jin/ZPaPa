import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  BotConfig,
  BotOutboundMessage,
  BotProviderAdapter,
  BotsConfigFile,
} from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { IZCodeTaskService } from "../src/session/zcodeTaskService.js";
import type { ISettingService } from "../src/setting/setting.js";
import type { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import { createBotsService } from "../src/bots/botsService.js";
import { formatBotInboxChannelSummary } from "../src/bots/messages.js";
import { INBOX_ITEM_KINDS, INBOX_ITEM_SEVERITIES } from "../src/workitem/inboxItemRepo.js";

/* SUB.3b：渠道**只读**推送的 bots 出站口（`IBotsService.pushInboxChannelSummary`）。

   期望值来源（不重算实现的分支）：
   · 投递目标 = 拆解报告 §2.4「每 workspace 一个通知渠道目标；未配置 ⇒ 零出站」＋ §7-Q2 裁定
     （形状复用 `ZCodeAutomationBotDeliveryTarget` 的**可推 provider 三值**：feishu / lark / weixin）；
   · 文案 = §2.4 文案行「kind 短词 + 工作项标题 + 项目 + 严重级 + 打开指引」，键集 = `INBOX_ITEM_KINDS`（9）穷尽；
   · 跳过语义 = §2.4 失败行「best-effort：失败只 warn（warn-once），绝不抛」，三种跳过照
     `watchAutomationRun` 先例（缺失 / 停用 / provider 不符）。

   fake provider adapter 观测 `send(bot, message)`：断言的是**出站消息的形状**（纯文本、无按钮、无回调），
   不是 HTTP 细节 —— 传输层各 provider 自有一套（飞书用卡片承载 markdown 文本），
   而「渠道只读」的机械保证在消息面上：没有 selection / elicitation，也就没有任何可回的操作入口。 */

function makeBot(over: Partial<BotConfig> = {}): BotConfig {
  return {
    id: "bot-1",
    name: "通知机器人",
    provider: "weixin",
    enabled: true,
    providerUserId: "user-1",
    allowedWorkspaces: ["ws-1"],
    allowedCommands: {
      status: true,
      new: true,
      workspace: true,
      model: true,
      mode: true,
      thoughtLevel: true,
      reply: true,
    },
    currentOptions: {},
    replyMode: "summary_changes",
    ...over,
  };
}

type Harness = {
  service: ReturnType<typeof createBotsService>;
  sent: BotOutboundMessage[];
  cleanup: () => void;
};

async function setup(config: BotsConfigFile): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "zcode-bots-inbox-"));
  setDataBaseDir(dir);
  const sent: BotOutboundMessage[] = [];
  const adapter: BotProviderAdapter = {
    test: async () => ({ ok: true, message: "ok" }),
    send: async (_bot, message) => {
      sent.push(message);
    },
    parseCallback: () => [],
  };
  const service = createBotsService({
    credentialService: { load: async () => null } as unknown as ICredentialService,
    zcodeTaskService: {} as unknown as IZCodeTaskService,
    settingService: {
      get: async () => ({ locale: "zh-CN" }),
    } as unknown as ISettingService,
    modelSelectionService: {
      getView: () => ({ providers: [] }),
    } as unknown as IModelSelectionService,
    runStartupBackgroundTasks: false,
    // **测试专用**的 provider 覆盖（照 `SquadRuntimeDeps.githubFetch` 先例）：只换掉被观测的那一个。
    providers: { weixin: adapter },
  });
  await service.saveConfig(config);
  return {
    service,
    sent,
    cleanup: () => {
      void service.disposeAllAndWait();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const TARGET = { workspacePath: "/repo/ZPaPa", workspaceIdentity: "ws-1" };

/* 源码守卫的取源工具（照 `inboxNotificationPolicy.test.ts` 的既有手法）：
   去注释再扫 —— 文件里的**说明文字**会引用这些词（「不得出现 selection」），不去注释会自咬。 */
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * 抠出一个函数/方法的**实现体**（从签名后的第一个 `{` 到配平的 `}`）。
 * 为什么不按行切片：守卫要扫的是**这个方法**，方法前后都是同一个 6000 行文件里的其它推送面
 * （入站、callback、命令解析），按行切会把它们扫进来、把守卫变成恒红。
 * 模板串里的 `${…}` 是配平的，不影响计数。
 */
function extractFunctionBody(source: string, signaturePrefix: string): string {
  const start = source.indexOf(signaturePrefix);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return "";
}

test("SUB.3b｜已配置（启用 + 已绑定 + 可主动投递的 provider）⇒ 恰一条纯文本推送到绑定会话", async () => {
  const h = await setup({ version: 3, bots: [makeBot()] });
  try {
    const result = await h.service.pushInboxChannelSummary({
      target: TARGET,
      summary: { kind: "merge_conflict", severity: "action_required", title: "修复登录" },
    });
    assert.deepEqual(result, { delivered: true, botId: "bot-1", provider: "weixin" });
    assert.equal(h.sent.length, 1, "新事实 ⇒ 恰一条出站");
    const message = h.sent[0]!;
    assert.equal(message.botId, "bot-1");
    assert.equal(message.provider, "weixin");
    assert.equal(message.providerUserId, "user-1", "投递到绑定会话");
    // 纯文本四行（§2.4 文案行）：kind 短词 + 标题 / 项目 / 严重级 / 打开指引。
    assert.equal(
      message.text,
      "【合并冲突】修复登录\n项目：ZPaPa\n严重级：需要处理\n打开 ZCode 收件箱查看并处理。",
    );
    assert.equal(message.selection, undefined, "渠道只读：无按钮");
    assert.equal(message.elicitation, undefined, "渠道只读：无可回的操作面");
  } finally {
    h.cleanup();
  }
});

test("SUB.3b｜未配置通知渠道（没有 bot 声明该 workspace）⇒ 零出站 + not_configured", async () => {
  const h = await setup({
    version: 3,
    bots: [makeBot({ allowedWorkspaces: ["ws-other"] })],
  });
  try {
    const result = await h.service.pushInboxChannelSummary({
      target: TARGET,
      summary: { kind: "merge_conflict", severity: "action_required", title: "修复登录" },
    });
    assert.equal(result.delivered, false);
    assert.equal(result.delivered === false ? result.reason : "", "not_configured");
    assert.equal(h.sent.length, 0, "未配置 ⇒ 零出站");
  } finally {
    h.cleanup();
  }
});

test("SUB.3b｜停用 / provider 不能主动投递 ⇒ 各自跳过，零出站（不换下一个 bot）", async () => {
  const disabled = await setup({ version: 3, bots: [makeBot({ enabled: false })] });
  try {
    const result = await disabled.service.pushInboxChannelSummary({
      target: TARGET,
      summary: { kind: "member_failed", severity: "attention", title: "修复登录" },
    });
    assert.equal(result.delivered === false ? result.reason : "", "bot_disabled");
    assert.equal(disabled.sent.length, 0);
  } finally {
    disabled.cleanup();
  }

  const telegram = await setup({
    version: 3,
    // 第二个 bot 可投递也不得顶替：命中即判定，「不能推」不是「换一个推」。
    bots: [makeBot({ provider: "telegram" }), makeBot({ id: "bot-2", provider: "weixin" })],
  });
  try {
    const result = await telegram.service.pushInboxChannelSummary({
      target: TARGET,
      summary: { kind: "member_failed", severity: "attention", title: "修复登录" },
    });
    assert.equal(result.delivered === false ? result.reason : "", "provider_mismatch");
    assert.equal(telegram.sent.length, 0);
  } finally {
    telegram.cleanup();
  }
});

test("SUB.3b｜文案两语成对：9 kind 短词互异 + 严重级三格 + 项目/标题/指引齐全", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const headlines: string[] = [];
    const summaries: string[] = [];
    for (const kind of INBOX_ITEM_KINDS) {
      for (const severity of INBOX_ITEM_SEVERITIES) {
        const text = formatBotInboxChannelSummary({
          locale,
          kind,
          severity,
          title: "修复登录",
          workspaceLabel: "ZPaPa",
        });
        const lines = text.split("\n");
        assert.equal(lines.length, 4, `${locale}/${kind}：摘要固定四行`);
        assert.ok(lines[0]!.includes("修复登录"), `${locale}/${kind}：首行必须带工作项标题`);
        assert.ok(
          lines[1]!.includes("ZPaPa"),
          `${locale}/${kind}：必须带项目名（否则「哪个项目」要靠猜）`,
        );
        assert.ok(lines[3]!.length > 0, `${locale}/${kind}：必须给打开指引`);
        headlines.push(lines[0]!);
        summaries.push(text);
      }
    }
    // 9 kind × 3 severity = 27 组：kind 短词恰 9 格互异（不是同一句兜底），
    // 全文 27 格互异（severity 那格也必须真的换词）。
    assert.equal(
      new Set(headlines).size,
      INBOX_ITEM_KINDS.length,
      `${locale}：kind 短词必须 9 格互异`,
    );
    assert.equal(
      new Set(summaries).size,
      INBOX_ITEM_KINDS.length * INBOX_ITEM_SEVERITIES.length,
      `${locale}：kind × severity 的组合必须互异（漏文案会表现成两句完全一样）`,
    );
  }

  // 两语的字面锚（独立抄自 §2.4 文案行的四件：kind 短词 / 标题 / 项目 / 严重级 / 指引）。
  assert.equal(
    formatBotInboxChannelSummary({
      locale: "zh-CN",
      kind: "decision_required",
      severity: "action_required",
      title: "选择数据库",
      workspaceLabel: "ZPaPa",
    }),
    "【有待裁决的决定】选择数据库\n项目：ZPaPa\n严重级：需要处理\n打开 ZCode 收件箱查看并处理。",
  );
  assert.equal(
    formatBotInboxChannelSummary({
      locale: "en-US",
      kind: "merge_conflict",
      severity: "action_required",
      title: "Fix login",
      workspaceLabel: "ZPaPa",
    }),
    "[Merge conflict] Fix login\nProject: ZPaPa\nSeverity: action required\nOpen the ZCode inbox to review and handle it.",
  );
});

test("SUB.3b｜渠道侧 send 失败 ⇒ send_failed（不抛、不重试）；跳过则 warn-once 不刷屏", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-bots-inbox-fail-"));
  setDataBaseDir(dir);
  let attempts = 0;
  const failing: BotProviderAdapter = {
    test: async () => ({ ok: true, message: "ok" }),
    send: async () => {
      attempts += 1;
      throw new Error("channel down");
    },
    parseCallback: () => [],
  };
  const service = createBotsService({
    credentialService: { load: async () => null } as unknown as ICredentialService,
    zcodeTaskService: {} as unknown as IZCodeTaskService,
    settingService: { get: async () => ({ locale: "zh-CN" }) } as unknown as ISettingService,
    modelSelectionService: {
      getView: () => ({ providers: [] }),
    } as unknown as IModelSelectionService,
    runStartupBackgroundTasks: false,
    providers: { weixin: failing },
  });
  await service.saveConfig({ version: 3, bots: [makeBot()] });

  const warns: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args);
  };
  try {
    const first = await service.pushInboxChannelSummary({
      target: TARGET,
      summary: { kind: "merge_conflict", severity: "action_required", title: "修复登录" },
    });
    assert.equal(first.delivered === false ? first.reason : "", "send_failed");
    const second = await service.pushInboxChannelSummary({
      target: TARGET,
      summary: { kind: "merge_conflict", severity: "action_required", title: "修复登录" },
    });
    assert.equal(second.delivered === false ? second.reason : "", "send_failed");
    assert.equal(attempts, 2, "两条事实各试一次：不重试（§7-Q7 不做投递台账）");

    // 同一 workspace + 同一原因在 TTL 内只留痕一次（照 watchAutomationRun 先例）。
    const deliveryWarns = warns.filter((args) =>
      args.some((arg) => String(arg).includes("inbox channel delivery")),
    );
    assert.equal(deliveryWarns.length, 1, `恰一条 warn-once，实得：${JSON.stringify(warns)}`);
    assert.ok(deliveryWarns[0]!.some((arg) => /reason=send_failed/.test(String(arg))));
  } finally {
    console.warn = original;
    void service.disposeAllAndWait();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SUB.3b｜只读机械保证（源码守卫）：推送块不含按钮 / 回调 / 入站 / 派发面", () => {
  const source = stripComments(readFileSync(resolve(SRC_ROOT, "bots/botsService.ts"), "utf8"));
  const body = extractFunctionBody(source, "async function pushInboxChannelSummary(");
  assert.ok(body.length > 0, "找不到 pushInboxChannelSummary 的实现体（守卫会退化成空跑）");
  assert.ok(
    body.includes("formatBotInboxChannelSummary(") && body.includes("adapter.send("),
    "抠出来的必须是这个方法本身的实现体（否则断言扫的是另一段源码）",
  );
  const forbidden = [
    "selection",
    "elicitation",
    "providerContextToken",
    "createOutbound",
    "handleInboundMessage",
    "handleProviderCallback",
    "parseCallback",
    "parseBotCommand",
    "commandParser",
    "Dispatch",
    "planDispatch",
    "publishDispatchRequest",
  ];
  for (const token of forbidden) {
    assert.ok(
      !body.includes(token),
      `pushInboxChannelSummary（去注释）不得出现 ${token}：` +
        "渠道只读 = 只有一条出站文本，结构上没有可回的操作入口，也就产生不了派发（12-11）。",
    );
  }
  /* 正控：这些 token 在**同一个文件**的其它推送面上是真实存在的（入站回执 / 选择卡片 / 命令解析）
     —— 证明本守卫的 token 表不是空集，「找不到」是真的没接进来，而不是拼错了词。 */
  assert.ok(
    forbidden.some((token) => source.includes(token)),
    "正控失败：整个文件都找不到这些 token ⇒ 守卫扫的是空集，结论不可信",
  );
});

test("SUB.3b｜挂接面唯一：出站只经 provider adapter 的 send（bots 域唯一主动发送口）", () => {
  const source = stripComments(readFileSync(resolve(SRC_ROOT, "bots/botsService.ts"), "utf8"));
  const body = extractFunctionBody(source, "async function pushInboxChannelSummary(");
  assert.equal(
    [...body.matchAll(/adapter\.send\(/g)].length,
    1,
    "恰一处 send：两处会在未来各自演化（一处加按钮、一处不加）",
  );
});
