import { useId, useState } from "react";
import type { McpServerConfig } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { FieldGroup } from "./squadDialogParts.js";
import {
  listMcpServerEntries,
  mcpServerNameErrorMessageId,
  mcpTransportMessageId,
  validateMcpServerEntry,
} from "./teamAgentMcpViewModel.js";

/* 协作智能体表单的「MCP 服务器」分区（per-agent MCP，设计 §3.6 / 切片的 UI 面）。

   形态对齐 multica 的 agent 级 MCP 面：**逐 server 行 + 对话框**（不是整段 `mcpServers` JSON 编辑器 ——
   我们的字段就是 map，整段编辑会诱导用户写错信封层级，而 strict schema 会以更难懂的方式拒）。
   行 = 名字 + 传输类型徽标 + 编辑/删除；对话框 = 名字（字符集 + 行内去重）+ 配置 JSON（浅校验）。

   判断全在 `teamAgentMcpViewModel.ts`（纯函数，node:test 直接钉住），本文件只做投影与状态编排：
   分区的值由父级对话框持有（受控），这里只保留「正在编辑哪一条」这一份**纯 UI 草稿**。

   两条提示是设计 §3.5 的文案落点（不建新机制）：
    · R4 —— `.zcode/squad/` 若被提交进仓库，MCP 凭据随仓库扩散；
    · R5 —— 授权码型（authorization_code）server 在无人值守 run 里只能等 15s 超时。 */

const BADGE_CLASSNAME = "text-ui-xs text-foreground-subtlest";
const HINT_CLASSNAME = "text-ui-xs text-foreground-subtlest";
const ERROR_CLASSNAME = "text-ui-xs text-destructive";

/** 编辑对话框的目标：`originalName` 为空 = 新建；非空 = 编辑该行（沿用原名不算重名，改名要把旧键删掉）。 */
type EditorTarget = { originalName: string | null; name: string; config: McpServerConfig };

export function TeamAgentMcpSection({
  servers,
  onChange,
}: {
  /** 该 agent 自有的 server map（缺席 = 不覆盖任何 server；空 map 合法）。 */
  servers: Record<string, McpServerConfig> | undefined;
  /** 提交给父级表单的状态更新（对话框持有唯一一份值，本分区不另存副本）。 */
  onChange: (next: Record<string, McpServerConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const rows = listMcpServerEntries(servers);
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  const saveEntry = (
    originalName: string | null,
    entry: { name: string; config: McpServerConfig },
  ) => {
    const next: Record<string, McpServerConfig> = { ...servers };
    // 改名 = 删旧键 + 写新键；同名覆盖 = 直接写（同名行的「更新」只有这一条路径）。
    if (originalName !== null && originalName !== entry.name) delete next[originalName];
    next[entry.name] = entry.config;
    onChange(next);
    setEditor(null);
  };

  const removeEntry = (name: string) => {
    const next: Record<string, McpServerConfig> = { ...servers };
    delete next[name];
    onChange(next);
  };

  return (
    <FieldGroup labelId="squad.common.mcpServers">
      <div className="flex flex-col gap-2" data-testid="squad-agent-mcp-section">
        {rows.length === 0 ? (
          <p className={HINT_CLASSNAME} data-testid="squad-agent-mcp-empty">
            {t("squad.agentMcp.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((row) => (
              <li
                key={row.name}
                className="flex items-center gap-2 text-ui-sm"
                data-testid="squad-agent-mcp-row"
              >
                <span className="min-w-0 flex-1 truncate text-foreground">{row.name}</span>
                <span className={BADGE_CLASSNAME} data-testid="squad-agent-mcp-transport">
                  {t(mcpTransportMessageId(row.transport))}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid="squad-agent-mcp-edit"
                  onClick={() =>
                    setEditor({
                      originalName: row.name,
                      name: row.name,
                      config: servers?.[row.name] ?? {},
                    })
                  }
                >
                  {t("squad.common.edit")}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid="squad-agent-mcp-remove"
                  aria-label={t("squad.agentMcp.removeAria", { name: row.name })}
                  onClick={() => removeEntry(row.name)}
                >
                  {t("squad.agentMcp.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="squad-agent-mcp-add"
            onClick={() => setEditor({ originalName: null, name: "", config: {} })}
          >
            {t("squad.agentMcp.add")}
          </Button>
        </span>
        <p className={HINT_CLASSNAME} data-testid="squad-agent-mcp-inherit-hint">
          {t("squad.agentMcp.inheritHint")}
        </p>
        <p className={HINT_CLASSNAME} data-testid="squad-agent-mcp-security-hint">
          {t("squad.agentMcp.securityHint")}
        </p>
        <p className={HINT_CLASSNAME} data-testid="squad-agent-mcp-oauth-hint">
          {t("squad.agentMcp.oauthHint")}
        </p>
        {editor ? (
          <McpServerEditorDialog
            key={editor.originalName ?? "*new*"}
            target={editor}
            existingNames={rows.map((row) => row.name)}
            onCancel={() => setEditor(null)}
            onSave={(entry) => saveEntry(editor.originalName, entry)}
          />
        ) : null}
      </div>
    </FieldGroup>
  );
}

/** 逐 server 的编辑对话框：名字 + 配置 JSON，两个行内错误，保存由合成判据驱动。 */
function McpServerEditorDialog({
  target,
  existingNames,
  onCancel,
  onSave,
}: {
  target: EditorTarget;
  existingNames: readonly string[];
  onCancel: () => void;
  onSave: (entry: { name: string; config: McpServerConfig }) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const [name, setName] = useState(target.name);
  const [configText, setConfigText] = useState(JSON.stringify(target.config, null, 2));
  const nameControlId = useId();
  const configControlId = useId();
  const isEdit = target.originalName !== null;
  const validation = validateMcpServerEntry({
    name,
    configText,
    existingNames,
    ...(target.originalName !== null ? { keepName: target.originalName } : {}),
  });

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(isEdit ? "squad.agentMcp.dialog.editTitle" : "squad.agentMcp.dialog.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("squad.agentMcp.dialog.hint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={nameControlId}>{t("squad.common.name")}</Label>
            <Input
              id={nameControlId}
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              data-testid="squad-agent-mcp-dialog-name"
            />
            {validation.nameIssue ? (
              <p className={ERROR_CLASSNAME} data-testid="squad-agent-mcp-dialog-name-error">
                {t(mcpServerNameErrorMessageId(validation.nameIssue))}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={configControlId}>{t("squad.agentMcp.dialog.config")}</Label>
            <Textarea
              id={configControlId}
              rows={6}
              value={configText}
              onChange={(event) => setConfigText(event.target.value)}
              data-testid="squad-agent-mcp-dialog-config"
              className="font-mono text-ui-xs"
            />
            {validation.configIssue && validation.configMessageId ? (
              <p className={ERROR_CLASSNAME} data-testid="squad-agent-mcp-dialog-config-error">
                {t(validation.configMessageId)}
                {/* schema 的首条 message 作副行（固定文案，不含用户内容）。 */}
                {validation.configDetail ? `：${validation.configDetail}` : ""}
              </p>
            ) : null}
          </div>
        </div>
        <SettingsFormActions>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("squad.common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!validation.entry}
            onClick={() => {
              if (validation.entry) onSave(validation.entry);
            }}
          >
            {t("squad.common.save")}
          </Button>
        </SettingsFormActions>
      </DialogContent>
    </Dialog>
  );
}
