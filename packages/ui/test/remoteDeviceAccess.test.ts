import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectedProjectList,
  createDeviceAccess,
  type DeviceServiceAccess,
} from "../src/lib/remoteDeviceAccess.js";

/**
 * 设备访问层的契约测试。
 *
 * 背景：设备级全量枚举（不指定项目）是较新能力，较早构建的对端会解引用空参数
 * 而报错。产品要求「投射端不强制对端升级」，因此访问层必须能探测能力并退化到
 * 「按已登记项目逐个查询」。这里用测试替身把两种对端都覆盖。
 */

function makeServices(options: {
  supportsDeviceWide: boolean;
  registered: string[];
  tasksByProject: Record<string, Array<{ taskId: string; title?: string }>>;
}): DeviceServiceAccess & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    settingService: {
      async get() {
        calls.push("setting.get");
        return { recentProjects: options.registered };
      },
    },
    zcodeTaskService: {
      async listTasks(params?: { workspacePath?: string }) {
        const project = params?.workspacePath;
        if (project === undefined) {
          calls.push("listTasks(全量)");
          if (!options.supportsDeviceWide) {
            // 模拟旧构建：缺省参数时解引用失败。
            throw new TypeError("Cannot read properties of undefined (reading 'workspacePath')");
          }
          const all = Object.entries(options.tasksByProject).flatMap(([path, tasks]) =>
            tasks.map((task) => ({ ...task, workspacePath: path })),
          );
          return all;
        }
        calls.push(`listTasks(${project})`);
        return (options.tasksByProject[project] ?? []).map((task) => ({
          ...task,
          workspacePath: project,
        }));
      },
    },
  };
}

test("对端支持设备级枚举时，一次查询拿到全部会话", async () => {
  const services = makeServices({
    supportsDeviceWide: true,
    registered: ["/p/one", "/p/two"],
    tasksByProject: {
      "/p/one": [{ taskId: "t1" }, { taskId: "t2" }],
      "/p/two": [{ taskId: "t3" }],
    },
  });
  const result = await createDeviceAccess(services);
  const tasks = await result.access.listAllTasks();

  assert.equal(tasks.length, 3);
  // 能力结论在首次枚举后才确定，因此先调用再读取。
  assert.equal(result.supportsDeviceWideEnumeration, true);
  // 不应退化为逐项目查询
  assert.ok(!services.calls.some((call) => call === "listTasks(/p/one)"));
});

test("对端不支持设备级枚举时，退化为按已登记项目查询并合并去重", async () => {
  const services = makeServices({
    supportsDeviceWide: false,
    registered: ["/p/one", "/p/two"],
    tasksByProject: {
      "/p/one": [{ taskId: "t1" }, { taskId: "t2" }],
      "/p/two": [{ taskId: "t2" }, { taskId: "t3" }], // t2 故意重复
    },
  });
  const result = await createDeviceAccess(services);
  const tasks = await result.access.listAllTasks();

  assert.equal(result.supportsDeviceWideEnumeration, false);
  assert.equal(tasks.length, 3, "重复的 taskId 应被合并");
  assert.ok(services.calls.includes("listTasks(/p/one)"));
  assert.ok(services.calls.includes("listTasks(/p/two)"));
});

test("能力探测只做一次", async () => {
  const services = makeServices({
    supportsDeviceWide: false,
    registered: ["/p/one"],
    tasksByProject: { "/p/one": [{ taskId: "t1" }] },
  });
  const { access } = await createDeviceAccess(services);
  await access.listAllTasks();
  await access.listAllTasks();
  const probes = services.calls.filter((call) => call === "listTasks(全量)").length;
  assert.equal(probes, 1, "探测结论应被缓存，不重复探测");
});

test("投影项目清单取已登记与有会话的并集", () => {
  const list = buildProjectedProjectList({
    registeredProjects: ["/p/registered-only", "/p/both"],
    tasks: [
      { taskId: "t1", workspacePath: "/p/both" },
      { taskId: "t2", workspacePath: "/p/both" },
      { taskId: "t3", workspacePath: "/p/has-sessions-only" },
    ],
  });

  assert.deepEqual(
    list.map((item) => item.path).sort(),
    ["/p/both", "/p/has-sessions-only", "/p/registered-only"],
    "新登记但无会话、以及有会话但未登记的项目都必须出现",
  );
  assert.equal(list.find((item) => item.path === "/p/both")?.sessionCount, 2);
  assert.equal(list.find((item) => item.path === "/p/registered-only")?.sessionCount, 0);
});

test("投影项目清单按会话数降序，同数按路径排序", () => {
  const list = buildProjectedProjectList({
    registeredProjects: [],
    tasks: [
      { taskId: "a", workspacePath: "/p/few" },
      { taskId: "b", workspacePath: "/p/many" },
      { taskId: "c", workspacePath: "/p/many" },
    ],
  });
  assert.deepEqual(list.map((item) => item.path), ["/p/many", "/p/few"]);
});
