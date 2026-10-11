/**
 * 卡片内容浏览器断言的夹具板（卡 #183）。
 *
 * 形态真源：`boardFoldFixture` 同款最小 v2 板字段形态；期望文本由被测脚本独立写死
 * （不用实现回算）。覆盖两种形态：
 *   - #301：三字段齐备且**带长文压力**（长中文 + 长英文连词，压 break-words/预格式化换行）；
 *   - #302：三字段缺省（真实板形态）→ 弹窗给显式「未携带」空态，不硬造。
 */
// 无分隔符长连词（溢出压力的真形态）：换行只能靠 `break-words`，去掉它窄档必溢出（突变抽检 M5 的靶）。
const LONG_TOKEN =
  "LONGTEXTTOKENabcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789";

export const CARD_TEXT_LONG_GOAL = `让拨开关后的状态在界面立刻生效（核心路径收口，含两条初始化路径与一次拨开关动作）。\n第二段：回归口径写清，避免再次踩到 ${LONG_TOKEN} 这类长连词把布局顶破。`;
export const CARD_TEXT_DELIVERABLES = [
  "开关接线单点收口（初始化 + 拨开关两条路径共用一份）",
  `updater 侧重复用——含超长项压力：${LONG_TOKEN}`,
  "回归断言补齐（含空值形态反例）",
];
export const CARD_TEXT_ACCEPTANCE =
  "用户拨开关后 1 秒内状态刷新，且无重复初始化调用；空值卡显示「板上未携带」。";

function feature(id: string, no: number, planCode: string, title: string): Record<string, unknown> {
  return {
    id,
    no,
    label: String(no),
    planCode,
    kind: "spec",
    title,
    details: "",
    status: "pending",
    statusRule: "夹具",
    stage: "待办",
    stageRule: "夹具",
    origin: { type: "spec-driven-workflow", specRoot: id.replace("spec:", "") },
    progress: { totalTasks: 2, completedTasks: 0 },
    evidence: [],
    createdAt: "2026-10-11T06:00:00+08:00",
    updatedAt: "2026-10-11T06:00:00+08:00",
    attention: [],
    tasks: [
      {
        no: 301,
        label: "301.1",
        title: "带卡片正文的卡（浏览器断言主样本）",
        details: "",
        status: "pending",
        statusRule: "夹具",
        stage: "待办",
        draft: false,
        origin: { type: "spec-driven-workflow", specRoot: id.replace("spec:", "") },
        evidence: [],
        assignees: ["implementer", "test-verifier", "code-reviewer", "integrator"],
        // #183 schema 提案字段（数据就绪形态的「有数据」样本）。
        goal: CARD_TEXT_LONG_GOAL,
        deliverables: CARD_TEXT_DELIVERABLES,
        acceptance: CARD_TEXT_ACCEPTANCE,
        blockers: [],
        attention: [],
        lastRun: null,
        activeRun: null,
        worktree: null,
        // 弹窗内 summary 之后留一个可聚焦件（pr 链接）：Tab 循环里 summary 不是末位，
        // 「summary 参与焦点序列」的断言才有确定的期望（见驱动注释）。
        pr: { number: 183, url: "https://github.com/ag-jin/ZPaPa/pull/183" },
        createdAt: "2026-10-11T06:00:00+08:00",
        updatedAt: "2026-10-11T06:00:00+08:00",
      },
      {
        no: 302,
        label: "302.1",
        title: "无卡片正文的卡（空值形态反例）",
        details: "",
        status: "pending",
        statusRule: "夹具",
        stage: "待办",
        draft: false,
        origin: { type: "spec-driven-workflow", specRoot: id.replace("spec:", "") },
        evidence: [],
        assignees: ["implementer"],
        blockers: [],
        attention: [],
        lastRun: null,
        activeRun: null,
        worktree: null,
        pr: null,
        createdAt: "2026-10-11T06:00:00+08:00",
        updatedAt: "2026-10-11T06:00:00+08:00",
      },
    ],
  };
}

export const CARD_TEXT_BOARD = {
  version: 2,
  project: { root: "/workspace/ZCode", name: "卡片内容夹具" },
  updatedAt: "2026-10-11T06:00:00+08:00",
  generatedBy: "zcode-board/0.5.0",
  features: [feature("spec:card-text-browser", 301, "TXT1", "卡片内容浏览器夹具")],
  attentionSummary: {
    interviewedNotArranged: 0,
    arrangedNotExpanded: 0,
    interruptedResume: 0,
    unmergedWorktree: 0,
  },
  diagnostics: [],
};
