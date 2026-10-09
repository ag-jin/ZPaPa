/**
 * 看板测试夹具（卡 #32）。
 *
 * 单一形态真源：`~/.zcode/skills/zcode-board/assets/samples/board.golden.json`
 * 的字段形态（本文件是形态夹具，不是 golden 的第二份副本 —— 完整 golden 的一致性
 * 由 `.zcode/board/evidence/T32/` 的可复现验证记录覆盖）。
 */

export const WORKSPACE = "/workspace/ZCode";
export const BOARD_PATH = `${WORKSPACE}/.zcode/board/board.json`;

/** 大板尾哨兵：唯一「只在读满全文之后才可能出现」的标题，用于识破默认/截断读取。 */
export const LARGE_BOARD_TAIL_TITLE = "尾哨兵：读全才可见";

export interface LargeBoardFixture {
  content: string;
  bytes: number;
  /** 尾哨兵标题在文本中的字节偏移（读全的判据：它必须大于读取上限）。 */
  tailByteOffset: number;
  featureCount: number;
}

/**
 * 大板夹具（读取上限回归用）：合法 v2 板，字节数撑过给定下限；
 * 首尾都是可判别的字段——读全才可能拿到末位尾哨兵。
 */
export function buildLargeBoard(params: { minBytes: number }): LargeBoardFixture {
  const features: Record<string, unknown>[] = [];
  const assemble = () =>
    JSON.stringify({
      version: 2,
      project: { root: WORKSPACE, name: "大板（读取上限回归）" },
      updatedAt: "2026-10-09T16:05:00+08:00",
      generatedBy: "zcode-board/0.2",
      features,
      attentionSummary: {
        interviewedNotArranged: 0,
        arrangedNotExpanded: 0,
        interruptedResume: 0,
        unmergedWorktree: 0,
      },
      diagnostics: [],
    });

  let index = 0;
  let content = assemble();
  while (Buffer.byteLength(content) < params.minBytes) {
    features.push({
      id: `plan:padding-${index}`,
      no: index + 10,
      label: String(index + 10),
      kind: "plan",
      title: `填充特性 ${index}`,
      details: "填充".repeat(60),
      status: "pending",
      attention: [],
      tasks: [],
    });
    index += 1;
    content = assemble();
  }

  features.push({
    id: "plan:tail-sentinel",
    no: 9999,
    label: "9999",
    kind: "plan",
    title: LARGE_BOARD_TAIL_TITLE,
    status: "pending",
    attention: [],
    tasks: [],
  });
  content = assemble();

  return {
    content,
    bytes: Buffer.byteLength(content),
    tailByteOffset: Buffer.byteLength(content.slice(0, content.indexOf(LARGE_BOARD_TAIL_TITLE))),
    featureCount: features.length,
  };
}

/**
 * 字段形态夹具：逐项覆盖 `board.golden.json` 的真实形态（四种缺口码、lastRun 三形态、
 * progress 有/无、未领号缺省、draft 卡、blockers 计数、pr、diagnostics）。
 * 期望值直接取自 golden 样例（独立真源），不是按实现回算。
 */
export const GOLDEN_SHAPED_BOARD = {
  version: 2,
  project: { root: WORKSPACE, name: "ZCode" },
  updatedAt: "2026-10-09T16:05:00+08:00",
  generatedBy: "zcode-board/0.2",
  features: [
    {
      id: "spec:preview-channel",
      no: 1,
      label: "1",
      kind: "spec",
      title: "预览通道（Preview Channel）",
      details: "确认 tag 规则 vX.Y.Z-preview.N 与四项实施任务，产物为 plan-sess_e5545aac。",
      status: "active",
      statusRule: "progress.stages.design=active",
      origin: { type: "spec-driven-workflow", specRoot: "specs/preview-channel/" },
      progress: { totalTasks: 4, completedTasks: 1 },
      evidence: ["specs/preview-channel/requirements.md"],
      createdAt: "2026-10-08T10:00:00+08:00",
      updatedAt: "2026-10-09T15:30:00+08:00",
      attention: [],
      stage: "执行中",
      tasks: [
        {
          no: 7,
          label: "1.1",
          title: "预览发布通道（workflow）",
          status: "pending",
          stage: "待办",
          statusRule: "tasks.md checkbox unchecked",
          draft: false,
          blockers: [
            {
              kind: "external",
              summary: "dev 污染 atom feed 待验证（决定方案 (a)/(b)）",
              evidence: ["specs/preview-channel/progress.json"],
            },
          ],
          attention: [],
          lastRun: {
            at: "2026-10-09T14:05:00+08:00",
            role: "code-reviewer",
            result: "done",
            stoppedAt: null,
            next: null,
          },
          activeRun: null,
          worktree: null,
          pr: null,
          updatedAt: "2026-10-09T14:05:00+08:00",
        },
        {
          no: 8,
          label: "1.2",
          title: "让开关立刻生效（核心）",
          status: "active",
          stage: "执行中",
          draft: false,
          blockers: [],
          attention: ["interrupted-resume", "unmerged-worktree"],
          lastRun: {
            at: "2026-10-09T14:20:00+08:00",
            role: "implementer",
            result: "partial",
            stoppedAt: 8,
            next: "补 updater 单测后重新验证",
          },
          activeRun: { role: "implementer", at: "2026-10-09T14:20:00+08:00" },
          worktree: ".zcode/worktrees/task-8",
          pr: null,
          updatedAt: "2026-10-09T14:20:00+08:00",
        },
        {
          no: 9,
          label: "1.3",
          title: "通道可见 + 版本序语义",
          status: "completed",
          stage: "已完成",
          draft: false,
          blockers: [],
          attention: [],
          lastRun: {
            at: "2026-10-09T15:30:00+08:00",
            role: "integrator",
            result: "done",
            stoppedAt: null,
            next: null,
          },
          activeRun: null,
          worktree: null,
          pr: { number: 41, url: "https://github.com/ag-jin/ZPaPa/pull/41" },
          updatedAt: "2026-10-09T15:30:00+08:00",
        },
      ],
    },
    {
      id: "plan:sess_f1a2d0bb",
      no: 6,
      label: "6",
      kind: "plan",
      title: "会话按需加载：上拖后台加载时，当前可见内容不许位移",
      details: "",
      status: "pending",
      statusRule: "plan 无勾选记录且无执行证据",
      origin: { type: "plan-session", sessionId: "sess_f1a2d0bb" },
      progress: null,
      evidence: [".zcode/plans/plan-sess_f1a2d0bb.md"],
      createdAt: "2026-10-01T10:42:00+08:00",
      updatedAt: "2026-10-01T10:42:00+08:00",
      tasks: [],
      attention: ["arranged-not-expanded"],
    },
    {
      id: "plan:plan-payment-split",
      kind: "plan",
      title: "支付拆分（旧稿）",
      details: "",
      status: "pending",
      statusRule: "plan 无勾选记录且无执行证据（未领号，等 --assign）",
      origin: { type: "plan-session", planRef: "docs/plans/plan-payment-split.md" },
      progress: null,
      evidence: ["docs/plans/plan-payment-split.md"],
      createdAt: "2026-09-30T09:00:00+08:00",
      updatedAt: "2026-09-30T09:00:00+08:00",
      attention: ["arranged-not-expanded"],
      tasks: [
        {
          title: "拆出支付回调服务（草案）",
          details: "把回调处理从主进程抽出为独立服务，先落接口。",
          status: "pending",
          stage: "待办",
          draft: true,
          blockers: [
            {
              kind: "dependency",
              blockedBy: 9,
              summary: "等待 #9 的通道函数落地后再合并回调路径",
              evidence: ["docs/plans/plan-payment-split.md"],
            },
          ],
          attention: [],
          lastRun: null,
          activeRun: null,
          worktree: null,
          pr: null,
          updatedAt: "2026-09-30T09:00:00+08:00",
        },
        {
          title: "回调幂等键（草案）",
          details: "幂等键字段与去重窗口待上游 tag 规则确定后再定。",
          status: "pending",
          stage: "待办",
          draft: true,
          blockers: [
            { kind: "external", summary: "上游 tag 规则未定", evidence: [] },
            { kind: "dependency", summary: "", evidence: [] },
          ],
          attention: [],
          lastRun: null,
          activeRun: null,
          worktree: null,
          pr: null,
          updatedAt: "2026-09-30T09:00:00+08:00",
        },
      ],
    },
    {
      id: "interview:itw-20261009-c3d4",
      kind: "interview-only",
      title: "面板分组与过滤",
      details: "确认大项目按模块分组折叠并按 status 过滤；尚未产出任何文件。",
      status: "pending",
      statusRule: "interview.status=open 且 outcome=none（无产物）",
      origin: { type: "interview", interviewId: "itw-20261009-c3d4" },
      evidence: [".zcode/board/interviews.json#itw-20261009-c3d4"],
      updatedAt: "2026-10-09T10:00:00+08:00",
      tasks: [],
      attention: ["interviewed-not-arranged"],
    },
  ],
  attentionSummary: {
    interviewedNotArranged: 1,
    arrangedNotExpanded: 2,
    interruptedResume: 1,
    unmergedWorktree: 1,
  },
  diagnostics: [
    {
      path: "docs/plans/plan-payment-split.md",
      message: "条目未领号（行尾无 zcode-board: no=N 标记）：按未领号上板，运行 --assign 补号。",
    },
  ],
};
