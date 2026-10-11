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
 *   - 层计数 = **该层实际承载的成员稿数**（`members.length` / `phases[].features.length`）——
 *     与渲染出来的子块逐一对齐（先例 `countBoardFeatureTasks`）；不另读登记行 rollup 回算，
 *     也不自算段位/缺口（§10.5 的壳层终态由登记行 `status` 唯一承载，本模块原样透出）。
 *   - 期次组只由**成员稿的期次**成组：不为落空期次造假容器（不吞稿、不造空章）。
 */
import type { BoardEpicNode, BoardFeatureNode, BoardViewModel } from "./boardViewModel.js";

/** 登记 id 前缀（§10.3）：`epic:<4位码>`——码不进引用位，裸码不认。 */
const EPIC_ID_PREFIX = "epic:";

export interface BoardPhaseGroup {
  /** 期次序（正整数，单值）。 */
  phase: number;
  /** 期次显示名（AD-3 双字段合成）：epic 码 + 期次序（`KANB1`）；只作容器层名/组头。 */
  name: string;
  /** 该期成员稿（文档序）。 */
  features: BoardFeatureNode[];
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
  const membersByCode = new Map<string, BoardFeatureNode[]>();
  const ungrouped: BoardFeatureNode[] = [];
  for (const feature of board.features) {
    const code = epicCodeOf(feature, codes);
    if (code === null || feature.phase === null) {
      ungrouped.push(feature);
      continue;
    }
    const members = membersByCode.get(code);
    if (members) members.push(feature);
    else membersByCode.set(code, [feature]);
  }
  return {
    epics: board.epics.map((epic) => {
      const members = membersByCode.get(epic.code) ?? [];
      const byPhase = new Map<number, BoardFeatureNode[]>();
      for (const member of members) {
        // phase 在本函数内已判非空（上面的守卫）；此处只做归期次。
        const phase = member.phase as number;
        const features = byPhase.get(phase);
        if (features) features.push(member);
        else byPhase.set(phase, [member]);
      }
      return {
        epic,
        members,
        phases: [...byPhase.entries()]
          .sort(([left], [right]) => left - right)
          .map(([phase, features]) => ({ phase, name: `${epic.code}${phase}`, features })),
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
    const phases = [...byPhase.entries()]
      .sort(([left], [right]) => left - right)
      .map(([phase, phaseItems]) => ({
        phase,
        name: `${group.epic.code}${phase}`,
        items: phaseItems,
      }));
    epics.push({ epic: group.epic, phases, items: phases.flatMap((phase) => phase.items) });
  }
  return { epics, ungrouped };
}
