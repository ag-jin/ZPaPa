# 内置默认配置

`config/default.json` 是随客户端发布的默认配置，必须保留。Desktop 打包时放入 resources/config；
远端请求失败或缺少有效字段时作为兜底值。

## 帮助入口去向

四个帮助入口（产品文档 / 用户社群 / 问题上报 / 提需求）已硬指 ZPaPa GitHub 仓库，
字面量统一收口在 `@zcode/shared` 的 `helpLinks`，不再请求 `GET /api/v1/client/configs`
解析 `data.configs.feedbackUrl`：

- 产品文档 → `https://github.com/ag-jin/ZPaPa#readme`
- 用户社群 → `https://github.com/ag-jin/ZPaPa/discussions`
- 问题上报 / 提需求 → `https://github.com/ag-jin/ZPaPa/issues/new`

本版没有帮助配置的读取代码（Desktop 不再构造帮助 config reader，`helpAppConfig` 与
`remoteAppConfig` 的反馈/社群解析已退役）。`default.json` 中的 feedback/community 字段
只作为随包默认值与 GitHub 去向保持一致，供部署基线和旧版客户端兼容；其它字段消费者不变。
