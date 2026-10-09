import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256Hex } from "../src/wake-rule.js";

/* 手写 SHA-256 的**外部对照**（spec §5.7.1 的 `sha256(stableStringify(payload))` 依赖它）。

   为什么必须有这个文件：`computeEventKey` 的用例全篇只比较 key 之间的相等/不等 ——
   **任何确定性函数都能通过**。也就是说这 70 行填充 + 轮常量一旦改坏，仓内不会有用例变红，
   而生产表现是「同一个事实的重投算出不同 key」⇒ 去重静默失效（每次重投都当新事实处理一次）。
   故这里把实现拉到 `node:crypto` 面前逐例比对：判据是**外部标准**，不是「我们自己算得自洽」。

   为什么能直接喂任意字节串：`computeEventKey` 的指纹族先过 `stableStringify`，
   其输出恒非空且形状受限（`null` / JSON 标量 / 规范化对象），空串与「恰好 55/56/63/64 字节
   的输入」在那里不可达 —— 而那正是填充最易写错的地方（`1` 位 + `0` 位到 56 (mod 64) 的取整）。
   所以对照直接打在这份实现上（`sha256Hex` 从 `wake-rule.ts` 导出，仅测试使用）。 */

const hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

test("sha256Hex 与 node:crypto 一致：空串 / 已知向量 / 常量", () => {
  // NIST FIPS 180-4 的教科书向量。既比对 node:crypto，也把**字面值**钉住：
  // 万一哪天真出现「两边以同样的方式一起错」，字面向量仍会红。
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(sha256Hex(""), hex(""));
  assert.equal(sha256Hex("abc"), hex("abc"));
});

test("sha256Hex 与 node:crypto 一致：块边界 55 / 56 / 63 / 64 字节", () => {
  // 这四个长度专挑填充的取整边界：55 是「不需要额外块」的最后一格（55 + 1 + 8 = 64），
  // 56 起必须多开一整块（56 + 1 + 8 = 65 ⇒ 128）；63/64 同理压在第二块的边界上。
  // 填充写错（例如把 `(56 - ((len + 1) % 64) + 64) % 64` 少加一次 64、或用 `% 64` 直接取负）
  // 只在**某些**长度上出错 —— 正是「随手挑一个长度测不出来」的那类 bug。
  for (const length of [55, 56, 63, 64]) {
    const input = "a".repeat(length);
    assert.equal(Buffer.byteLength(input, "utf8"), length, `输入应为 ${length} 字节`);
    assert.equal(sha256Hex(input), hex(input), `长度 ${length} 字节的输入应算出同一摘要`);
  }
});

test("sha256Hex 与 node:crypto 一致：0..130 字节全扫（填充的每个边界与多块）", () => {
  // 逐长度扫描而不是抽查：填充错误的窗口通常只有一两个长度宽，抽查会漏。
  // 130 覆盖到「第三块中途」，把「多块时长度字段与调度表交替推进」这条路径也走到。
  for (let length = 0; length <= 130; length += 1) {
    const input = "b".repeat(length);
    assert.equal(sha256Hex(input), hex(input), `长度 ${length} 字节`);
  }
});

test("sha256Hex 与 node:crypto 一致：长输入（≥1000 字节）与恰好 64 字节的多字节串", () => {
  // 长输入：摘要要跨很多块，且长度字段的高位字首次变得有意义（>2^32 bit 才非零，这里 1000 字节还不会，
  // 但多块的级联错误会暴露）。同时用重复模式之外的内容，避免「把上一块的 state 抄下来」也能过。
  const long = "0123456789abcdef".repeat(64); // 1024 字节
  assert.equal(Buffer.byteLength(long, "utf8"), 1024);
  assert.equal(sha256Hex(long), hex(long));

  // 多字节 UTF-8：走的是 `TextEncoder` ⇒ UTF-8 编码这一环（`String.length` 与字节数不同）。
  // 若实现天真地用 `length` 当字节数（而不是编码后的 `data.length`），这里会与 node:crypto 分叉。
  const cjk = "中文·测试🚀";
  assert.notEqual(Buffer.byteLength(cjk, "utf8"), cjk.length); // 前提：确实是多字节输入
  assert.equal(sha256Hex(cjk), hex(cjk));

  // 恰好 64 字节但含多字节字符：把「块边界」与「多字节编码」两条路径叠在一起。
  const cjkAtBoundary = `${"中".repeat(21)}x`; // 21 * 3 + 1 = 64 字节
  assert.equal(Buffer.byteLength(cjkAtBoundary, "utf8"), 64);
  assert.equal(sha256Hex(cjkAtBoundary), hex(cjkAtBoundary));

  // 1000 字节以上的多字节输入（长度字段与编码同时被推到不同于 ASCII 的形态）。
  const longCjk = "汉字输入".repeat(250); // 4 字 * 3 字节 * 250 = 3000 字节
  assert.ok(Buffer.byteLength(longCjk, "utf8") >= 1000);
  assert.equal(sha256Hex(longCjk), hex(longCjk));
});
