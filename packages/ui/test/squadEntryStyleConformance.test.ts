import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/* 四个新入口页面（工作项 / 收件箱 / 智能体 / 小队）的**风格一致性守卫**（DESIGN.md 适配轮）。

   为什么是源码级守卫（而不是渲染断言）：本包对这四个页面没有交互/渲染测试设施（既定做法，
   见 inboxPage.test.ts / wakeRulesPage.test.ts 的同一句注），而这一轮改的全是**类名 token**
   —— 判据是「类名与 DESIGN.md 的条款一致」，不是行为。守卫读源码，断言的是**渲染出去的类名**，
   与既有 `workItemProperties.test.ts` 钉 ROW_CLASSNAME 的形态同款。

   每条守卫都写明：条款出处 + 变异（改回去 ⇒ 红）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** 去掉注释后再扫类名：注释里出现"被禁的类名"是说明文字，不是渲染出去的样式
    （守卫的判据是**代码里用到的类名**，不是文本里提到过它）。 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ---------- ① 圆角层级：页面里「第一个圆角容器」= rounded-xl ----------

   DESIGN.md「Radius ▸ Container hierarchy」：Layout regions / ordinary wrappers / groups /
   separators 不计层级，「The first rounded container starts at rounded-xl, whether inside or
   outside a layout region」。四个页面的页面列（shell 的居中内容列）是布局区，不计层级 ⇒
   列表行就是该页**第一个**圆角容器 ⇒ rounded-xl（不是 rounded-lg —— 那是"嵌在卡片里"的层级）。

   变异：把任一 ROW_CLASSNAME 改回 `rounded-lg ...`（或改回"卡片里低一级"的旧口径）⇒ 对应断言红。 */
/* 本轮适配覆盖的组件树（四页 + 各自渲染出来的相邻件）。WorkItemRows.tsx / WorkItemsBoard.tsx
   的**布局结构**属另一条线（multica 列+卡片重排，取证在途）⇒ 只按既有逐字节基线冻结、不改。
   `WorkItemMentionMenu` / `WorkItemDeliverablesSection` / `WorkItemPullRequestsSection` /
   `WorkItemDetailOverview` 属**工作项详情页**的树（不是这四个入口页）⇒ 不在本轮清单里。 */
const IN_SCOPE_FILES = [
  "squad/InboxPage.tsx",
  "squad/InboxList.tsx",
  "squad/inboxViewModel.ts",
  "squad/SquadAgentsPage.tsx",
  "squad/SquadAgentsList.tsx",
  "squad/SquadsPage.tsx",
  "squad/SquadsList.tsx",
  "squad/WorkItemsPage.tsx",
  "squad/WorkItemsPageActions.tsx",
  "squad/WorkItemsPageStatus.tsx",
  "squad/WorkItemsPageDialogs.tsx",
  "squad/WorkItemsViewsSection.tsx",
  "squad/WorkItemsSurface.tsx",
  "squad/WorkItemViewsBar.tsx",
  "squad/WorkItemViewDialogs.tsx",
  "squad/WorkItemQuickCreate.tsx",
  "squad/WorkItemBulkToolbar.tsx",
  "squad/WorkItemListView.tsx",
  "squad/WorkItemTableView.tsx",
  "squad/WorkItemTableCell.tsx",
  "squad/WorkItemPriorityField.tsx",
  "squad/WorkItemPeek.tsx",
  "squad/WorkItemMobileSheet.tsx",
  "squad/SquadRunsReview.tsx",
  "squad/SquadTimelineSection.tsx",
  "squad/WakeRulesSection.tsx",
  "squad/WakeRuleDialogs.tsx",
  "squad/CreateWakeRuleDialog.tsx",
  "squad/SquadCreateDialogs.tsx",
  "squad/squadDialogParts.tsx",
  "squad/AgentBuilderDialog.tsx",
  "squad/AgentBuilderPanel.tsx",
  "squad/ReassignWorkItemDialog.tsx",
  "squad/SquadDiscardDialog.tsx",
] as const;

test("风格守卫｜四页列表行是该页第一个圆角容器 ⇒ rounded-xl（DESIGN Radius 层级）", () => {
  const firstLevelRows = [
    "squad/InboxList.tsx",
    "squad/SquadAgentsList.tsx",
    "squad/SquadsList.tsx",
    "squad/SquadRunsReview.tsx",
    "squad/WakeRulesSection.tsx",
  ];
  for (const file of firstLevelRows) {
    const source = readSource(file);
    assert.ok(
      source.includes('const ROW_CLASSNAME = "rounded-xl border border-border px-3 py-2";'),
      `${file} 的行容器必须是 rounded-xl（页面上第一个圆角容器；旧注释里的"所在卡片"在本页并不存在）`,
    );
    assert.ok(
      !source.includes('const ROW_CLASSNAME = "rounded-lg border border-border px-3 py-2";'),
      `${file} 不得保留 rounded-lg 的旧口径`,
    );
  }
});

/* ---------- ② 色：不得引用主题里不存在的 token；错误文案走 destructive ----------

   DESIGN.md「Color Usage Rules」：「Use semantic tokens, not raw one-off color values」；
   「Semantic feedback colors」里唯一的错误色族是 `--color-destructive`。

   为什么这条能机械判：`text-[var(--color-<x>)]` 里的 var() 指向**主题变量**，真源是
   `packages/ui/src/styles.css` 的 @theme 块（不在那里的变量在运行时是无效声明 —— 颜色回落到
   inherit，错误文案看起来与正文一样）。守卫把『源码引用的 token 集合』与『主题定义的 token 集合』
   对账，不猜。

   变异：把任一 `text-destructive` 改回 `text-[var(--color-danger)]` ⇒ 该断言红。 */
test("风格守卫｜四页组件树不得引用主题未定义的 --color-* token（错误文案走 text-destructive）", () => {
  const theme = readSource("styles.css");
  const defined = new Set(
    [...theme.matchAll(/^\s*--color-([a-z0-9-]+):/gm)].map((match) => match[1]),
  );
  assert.ok(defined.has("destructive"), "主题必须定义 destructive（前置事实，否则本守卫无意义）");
  assert.ok(!defined.has("danger"), "主题里没有 --color-danger（前置事实）");

  for (const file of IN_SCOPE_FILES) {
    const source = readSource(file);
    for (const match of source.matchAll(/var\(--color-([a-z0-9-]+)\)/g)) {
      assert.ok(
        defined.has(match[1]),
        `${file} 引用了主题未定义的 --color-${match[1]}（无效声明 ⇒ 颜色回落 inherit）`,
      );
    }
  }

  for (const file of ["squad/WakeRulesSection.tsx", "squad/SquadTimelineSection.tsx"]) {
    const source = readSource(file);
    assert.ok(
      source.includes("text-destructive"),
      `${file} 的错误文案必须走 text-destructive（语义色单源）`,
    );
    assert.ok(!source.includes("var(--color-danger)"), `${file} 不得再引用不存在的 --color-danger`);
  }
});

/* ---------- ③ 色：`muted` 系 utility 在本主题不存在（写死一枚不生成任何规则的类名） ----------

   DESIGN.md「Implementation Guidance」：Reuse existing semantic tokens；「Color Usage Rules」：
   Use semantic tokens, not raw one-off color values。

   事实：本仓主题（styles.css 的 @theme）没有 `--color-muted` / `--color-muted-foreground`
   （shadcn 上游有，本仓没有），所以 `bg-muted` / `text-muted-foreground` 编译不出任何规则
   —— 徽标会退化成"只有文字、没有底色"。中性弱底色在本主题的语义 token 是 `bg-surface`
   （DESIGN「Cards and Panels」Low-emphasis containers use bg-surface）。

   变异：把 `bg-surface` 改回 `bg-muted` ⇒ 本断言红。 */
test("风格守卫｜四页组件树不得使用主题未定义的 muted 系 utility（中性徽标走 bg-surface）", () => {
  const theme = readSource("styles.css");
  const defined = new Set(
    [...theme.matchAll(/^\s*--color-([a-z0-9-]+):/gm)].map((match) => match[1]),
  );
  assert.ok(!defined.has("muted"), "前置事实：本主题没有 --color-muted（上游 shadcn 有）");

  for (const file of IN_SCOPE_FILES) {
    const source = stripComments(readSource(file));
    for (const match of source.matchAll(/\b(?:bg|text|border)-muted(?:-foreground)?\b/g)) {
      assert.fail(`${file} 使用了主题未定义的 ${match[0]}（编译不出规则 ⇒ 底色/颜色静默丢失）`);
    }
  }

  assert.ok(
    readSource("squad/inboxViewModel.ts").includes('info: "bg-surface text-foreground-subtle"'),
    "收件箱 info 严重度的中性徽标走 bg-surface（本主题的弱底色 token）",
  );
  assert.ok(
    readSource("squad/wakeRulesViewModel.ts").includes(
      'user_paused: "bg-surface text-foreground-subtle"',
    ),
    "唤醒规则 user_paused 徽标走 bg-surface",
  );
});

/* ---------- ④ 圆角形态：rounded-full 只留给"刻意做圆"的形（圆点/圆圈） ----------

   DESIGN.md「Radius ▸ Shape exceptions and consistency」：`rounded-full` is reserved
   exclusively for deliberate pill shapes or circles —— 「Buttons, tags, counters, and icon
   buttons do not qualify for rounded-full merely because of their component type」。

   变异：给搜索框的清除图标钮加回 `rounded-full`（图标钮不是圆圈）⇒ 第一断言红；
   给唤醒规则状态徽标加回 `rounded-full`（tag 不是药丸）⇒ 第二断言红。 */
test("风格守卫｜图标钮与状态徽标不得用 rounded-full（DESIGN Shape exceptions）", () => {
  const actions = stripComments(readSource("squad/WorkItemsPageActions.tsx"));
  assert.ok(
    !actions.includes("rounded-full"),
    "搜索框的清除图标钮不得是圆（图标钮默认跟随控件圆角；rounded-full 只留给刻意做圆）",
  );
  assert.ok(
    actions.includes('size="icon-sm"'),
    "清除钮仍是 icon-sm 的既有尺寸（本守卫只禁圆角形态，不动尺寸/行为）",
  );

  const wakeRules = stripComments(readSource("squad/WakeRulesSection.tsx"));
  assert.ok(!wakeRules.includes("rounded-full"), "唤醒规则区不得出现 rounded-full（徽标不是药丸）");
  assert.ok(
    wakeRules.includes('"shrink-0 rounded-md px-2 py-0.5 text-ui-xs"'),
    "状态徽标用 rounded-md（本仓填充式状态徽标的既有档位，如 UpdateStatusDialog / SubagentsSection）",
  );
});

/* ---------- ⑤ 圆角：不得用语义含糊的裸 `rounded` ----------

   DESIGN.md「Radius ▸ Shape exceptions and consistency」：Do not introduce arbitrary radius
   values or use the ambiguous bare `rounded` utility。本仓 Tailwind v4 里裸 `rounded` 仍有
   0.25rem 的兼容实现（能生成规则，但不是设计系统里的档位名）⇒ 换成显式档位 `rounded-sm`
   （v4 的 0.25rem，与页面上同类 chip 的既有视觉一致）。

   变异：把 WorkItemPeek 的属性 chip 改回裸 `rounded` ⇒ 本断言红。 */
test("风格守卫｜四页组件树不得使用裸 rounded utility（DESIGN 禁含糊档位）", () => {
  for (const file of IN_SCOPE_FILES) {
    const source = stripComments(readSource(file));
    if (/(?:^|[" ])rounded(?=[" ]|$)/m.test(source)) {
      assert.fail(`${file} 使用了裸 rounded（语义含糊；改为显式档位，如 rounded-sm）`);
    }
  }
  assert.ok(
    stripComments(readSource("squad/WorkItemPeek.tsx")).includes(
      'className="flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5"',
    ),
    "peek 的自定义属性 chip 用显式档位 rounded-sm",
  );
});

/* ---------- ⑥ 圆角层级：对话框里的第一层内容容器 = rounded-xl（聊天气泡同理） ----------

   DESIGN.md「Radius ▸ Dialogs」：The dialog shell does not count toward its content
   hierarchy. The first rounded content container starts again at `rounded-xl`.
   「Chat, Tooling, and Developer UI」：Chat bubbles follow the container hierarchy,
   starting at `rounded-xl`（仓内先例：ConversationRowView 的用户气泡 = rounded-xl）。

   变异：把 AgentBuilderPanel 里任一处容器改回 rounded-lg（"对话框里低一级"的旧口径）⇒ 红。 */
test("风格守卫｜AI 访谈面板：气泡/内容容器是该对话框的第一层 ⇒ rounded-xl", () => {
  const panel = stripComments(readSource("squad/AgentBuilderPanel.tsx"));
  assert.ok(
    !panel.includes("rounded-lg"),
    "访谈面板里的转写气泡与内容容器必须是 rounded-xl（对话框壳不计层级）",
  );
  assert.ok(
    panel.includes('"rounded-xl border px-3 py-2 text-ui-sm whitespace-pre-wrap"'),
    "气泡基础类名 = rounded-xl",
  );
  assert.ok(
    panel.includes(
      'className="rounded-xl border border-border bg-input/20 px-3 py-2 text-ui-sm text-foreground-subtle"',
    ),
    "空转写提示 = 同一层级 ⇒ 同圆角（peer containers use the same radius）",
  );
  assert.ok(
    panel.includes(
      'className="flex flex-col gap-2 rounded-xl border border-border bg-input/20 px-3 py-2"',
    ),
    "草稿卡 = 同一层级的另一个内容容器 ⇒ rounded-xl",
  );
});
