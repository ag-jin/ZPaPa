/**
 * 三层容器装配：epic（大功能）⊃ phase（期次）⊃ 稿（既有计划特性）——卡 #87 / A4-1 tracer。
 *
 * 单一真源：markers.md §10（三层容器与登记行语法：`epics[]` 登记行、`features[].epic`/`phase`
 * 归属对原子性）、board-consumption-contract.md §0 字段表、以及 board.md 的 epic 章渲染口径
 * （A3-2/#85：无归属稿与孤儿引用稿顶层平铺、不为孤儿造章、期次序升序）——**渲染语义与 board.md
 * 正常板同口径**（CR-S4 勘误：违规/手改板上按本模块显式回退——半对稿顶层平铺而 board.md 不呈现、
 * 空期次不造容器而 board.md 渲染空章；此类板由 A2-2 断言包在编译期点名），本模块只把同一口径映射成可渲染结构；A4-1b 的三视图复用本模块，禁二份实现。
 *
 * 边界（只读投影，禁自算）：
 *   - 归组只认**登记 id 反查**（`epic:<码>` 且码在 `epics[]` 里）：稳定号引用无登记面映射
 *     （board.json 不带 registry 面）、孤儿引用无登记行 → 都顶层平铺、不造章（AD-8）。
 *   - 期次显示名 = `epic 码 + 期次序` 双字段合成（AD-3：`KANB`+1 → `KANB1`）；5 字符名只活在
 *     显示层，不进卡编号命名空间（AD-2：卡编号维持 `计划码-层级`）。
 *   - **组序统一比较器（#88/A4-2；AD-4 改判 = 纯期次序）：epic 内期次按 `compareBoardPhaseOrder`
 *     数字升序、epic 间按登记序——两种层级都只此一处排序（tree 的归组段），list/kanban/table 的
 *     视图侧装配复用该序列、不各自重排（禁二份）。显示名合成同守单点 `phaseDisplayName`。#168 评审
 *     S1 收口：此前的合成名 + 期次升序排序在归组与视图侧装配两处重复，现收敛为「唯一排序点 +
 *     合成名单点」，两处共用。
 *   - 层计数 = **该层实际承载的成员稿数**（`members.length` / `phases[].features.length`）——
 *     与渲染出来的子块逐一对齐（先例 `countBoardFeatureTasks`）；不另读登记行 rollup 回算，
 *     也不自算段位/缺口（§10.5 的壳层终态由登记行 `status` 唯一承载，本模块原样透出）。
 *   - 期次组只由**成员稿的期次**成组：不为落空期次造假容器（不吞稿、不造空章）。
 */
import type { BoardEpicNode, BoardFeatureNode, BoardViewModel } from "./boardViewModel.js";

/** 登记 id 前缀（§10.3）：`epic:<4位码>`——码不进引用位，裸码不认。 */
const EPIC_ID_PREFIX = "epic:";

export interface BoardPhaseGroup {
  /** 期次序（正整数，单值）；组序判据 = `compareBoardPhaseOrder`（AD-4 纯期次序）。 */
  phase: number;
  /** 期次显示名（AD-3 双字段合成）：epic 码 + 期次序（`KANB1`）；只作容器层名/组头。 */
  name: string;
  /** 该期成员稿（文档序）。 */
  features: BoardFeatureNode[];
}

/**
 * 期次显示名单点（AD-3 双字段合成）：`epic 码 + phase 序号` 直接拼接——`KANB` + 1 → `KANB1`。
 * 合成名只活在显示层（容器层名/组头），不进任何码位字段（AD-2：卡编号维持 计划码-层级）。
 */
export function phaseDisplayName(epicCode: string, phase: number): string {
  return `${epicCode}${phase}`;
}

/**
 * 组序统一比较器单点（卡 #88 / A4-2；AD-4 改判 = **纯期次序**）：只比期次序数字升序
 * （1 → 2 → 3 → 10 按数值，不按显示名 `KANB10` 的字典序——两者在两位数期次上分叉）。
 *
 * 明确**不采用**的依据（曾被推荐、已拍板否掉）：「缺口优先 + 期次序混合」——比较器只读期次序，
 * 不读成员 `attention`/`blockers`/`stage`/`status`，也不看成员文档序/视图输入序；缺口信号
 * （展开默认态、徽章）归呈现层与 A4-3/A4-4，不改组序。epic 间顺序 = `board.epics[]` 登记序
 * （调用方按登记序遍历，不经本比较器）。
 *
 * 四视图共用：tree 走 `groupBoardFeaturesByEpic`（唯一排序点）；list/kanban/table 的
 * `assembleBoardEpicContainers` 直接复用该 grouping 段的期次序列与合成名（禁各自重排/重拼）。
 */
export function compareBoardPhaseOrder(left: number, right: number): number {
  return left - right;
}

/** 期次分桶 → 有序条目（**唯一排序点**：比较器只用在这里；合成名走 `phaseDisplayName`）。 */
function orderedPhaseEntries<M>(byPhase: ReadonlyMap<number, M[]>): Array<[number, M[]]> {
  return [...byPhase.entries()].sort(([left], [right]) => compareBoardPhaseOrder(left, right));
}

export interface BoardEpicGroup {
  /** 登记行（登记序；终态由 `epic.status` 承载，本层不推导）。 */
  epic: BoardEpicNode;
  /** 期次组（期次序升序）。 */
  phases: BoardPhaseGroup[];
  /** 成员稿（文档序，= 各期次之并集；层计数用 `members.length`）。 */
  members: BoardFeatureNode[];
}

export interface BoardEpicGrouping {
  /** epic 容器（登记序）。零 epic 项目 → 空数组（AD-8：照旧平铺）。 */
  epics: BoardEpicGroup[];
  /** 无归属稿（`epic`/`phase` 双缺省）、孤儿引用稿、稳定号引用稿、归属对不成全稿：顶层平铺（文档序）。 */
  ungrouped: BoardFeatureNode[];
}

/**
 * 归组判据（单点；与 board.md `epicCodeOf` 同口径）：只有登记 id 形态且能反查到登记行才归组。
 * 归属对不成全（只有 `epic` 或只有 `phase`）是违规板（§10.3 原子对；断言归 A2-2）——渲染层按
 * 无归属平铺，**不吞稿、不造空容器**。
 */
function epicCodeOf(feature: BoardFeatureNode, codes: ReadonlySet<string>): string | null {
  const reference = feature.epic;
  if (reference === null || !reference.startsWith(EPIC_ID_PREFIX)) return null;
  const code = reference.slice(EPIC_ID_PREFIX.length);
  return codes.has(code) ? code : null;
}

export function groupBoardFeaturesByEpic(board: BoardViewModel): BoardEpicGrouping {
  const codes = new Set(board.epics.map((epic) => epic.code));
  // 成员期次在归桶时随行携带（#60/T-3：消费处不再 `member.phase as number` 断言——
  // 上面的守卫已判非空，把收窄后的 `number` 直接存下来，后面只读）。
  const membersByCode = new Map<string, Array<{ feature: BoardFeatureNode; phase: number }>>();
  const ungrouped: BoardFeatureNode[] = [];
  for (const feature of board.features) {
    const code = epicCodeOf(feature, codes);
    const phase = feature.phase;
    if (code === null || phase === null) {
      ungrouped.push(feature);
      continue;
    }
    const member = { feature, phase };
    const members = membersByCode.get(code);
    if (members) members.push(member);
    else membersByCode.set(code, [member]);
  }
  return {
    epics: board.epics.map((epic) => {
      const members = membersByCode.get(epic.code) ?? [];
      const byPhase = new Map<number, BoardFeatureNode[]>();
      for (const { feature, phase } of members) {
        // 归期次：phase 已在上面的守卫处收窄，这里只分组。
        const features = byPhase.get(phase);
        if (features) features.push(feature);
        else byPhase.set(phase, [feature]);
      }
      return {
        epic,
        members: members.map((member) => member.feature),
        // 唯一排序点：期次序升序（纯期次序比较器）；合成名同守单点（AD-3）。
        phases: orderedPhaseEntries(byPhase).map(([phase, features]) => ({
          phase,
          name: phaseDisplayName(epic.code, phase),
          features,
        })),
      };
    }),
    ungrouped,
  };
}

/** 视图侧某一层实际承载的成员分组（`items` = 该视图管线产出的分组，保持输入序）。 */
export interface BoardEpicItemContainer<T> {
  /** 登记行（登记序）。 */
  epic: BoardEpicNode;
  /** 期次组（期次序升序）——只含本视图实际承载的成员分组。 */
  phases: Array<{ phase: number; name: string; items: T[] }>;
  /** 本视图实际承载的成员（= 各期次之并集；容器层计数来源）。 */
  items: T[];
}

/**
 * 视图侧三层容器装配（卡 #168 / A4-1b 三视图共用单点；禁二份实现）：
 * 把一份**视图侧已过滤/排序的分组**（列表/表格的特性分组、看板列内的分组块）按同一 epic/phase
 * 归属切成容器——归组判据只认登记 id 反查（`groupBoardFeaturesByEpic` 单点），半对稿/孤儿引用/
 * 稳定号引用一律 `ungrouped` 顶层平铺，三视图不各写一套判据。
 *
 * `items` 是**视图侧的分组**（`memberIdOf` 取组头特性 id，看板跨列轻量组同样按特性归属）；
 * **只保留实际承载 ≥1 分组的层**：过滤/列投影后没有成员就不造空壳（层计数 = 实际承载成员数，
 * 与渲染出来的子块逐一对齐）——空壳承诺只在结构视图（tree 直接消费 `groupBoardFeaturesByEpic`，
 * 登记 epic 照旧成章；列表/表格/看板按本函数投影）。
 *
 * 组序/合成名（#88/A4-2）：epic 间按登记序、期次按期次序升序（`compareBoardPhaseOrder`），
 * 序列与名字直接取自 grouping 段——本函数**不重排、不重拼**（#168 评审 S1 收口：此处原有的
 * 第二份排序 + `epic 码 + 期次` 拼接已删除）。
 */
export function assembleBoardEpicContainers<T>(
  board: BoardViewModel,
  items: readonly T[],
  memberIdOf: (item: T) => string,
): { epics: Array<BoardEpicItemContainer<T>>; ungrouped: T[] } {
  const grouping = groupBoardFeaturesByEpic(board);
  const attribution = new Map<string, { code: string; phase: number }>();
  for (const group of grouping.epics) {
    for (const phaseGroup of group.phases) {
      for (const member of phaseGroup.features) {
        attribution.set(member.id, { code: group.epic.code, phase: phaseGroup.phase });
      }
    }
  }
  const itemsByCode = new Map<string, Map<number, T[]>>();
  const ungrouped: T[] = [];
  for (const item of items) {
    const entry = attribution.get(memberIdOf(item));
    if (!entry) {
      ungrouped.push(item);
      continue;
    }
    let byPhase = itemsByCode.get(entry.code);
    if (!byPhase) {
      byPhase = new Map();
      itemsByCode.set(entry.code, byPhase);
    }
    const bucket = byPhase.get(entry.phase);
    if (bucket) bucket.push(item);
    else byPhase.set(entry.phase, [item]);
  }
  const epics: Array<BoardEpicItemContainer<T>> = [];
  for (const group of grouping.epics) {
    const byPhase = itemsByCode.get(group.epic.code);
    if (!byPhase) continue;
    const phases: BoardEpicItemContainer<T>["phases"] = [];
    // 期次序列与合成名直接复用 grouping 段（#88/A4-2 单点：视图侧不重排、不重拼）。
    for (const phaseGroup of group.phases) {
      const phaseItems = byPhase.get(phaseGroup.phase);
      if (!phaseItems) continue;
      phases.push({ phase: phaseGroup.phase, name: phaseGroup.name, items: phaseItems });
    }
    epics.push({ epic: group.epic, phases, items: phases.flatMap((phase) => phase.items) });
  }
  return { epics, ungrouped };
}
