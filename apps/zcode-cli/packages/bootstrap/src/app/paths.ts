import { basename, join } from "node:path";
import { createProjectId, type ProjectId } from "@zcode/contracts";
import { resolveProjectMemoryRoot } from "@zcode/core";

export function getCliStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

/**
 * agent 产物根目录（`<cliStorageRoot>/agents`）。唯一装配点：create-app 与协议 entrypoint 共用，
 * 避免「runner 往 A 写、重启收敛从 B 读 pid 证据」的路径漂移（spec §1.4b W2）。
 */
export function getSubagentOutputRootDir(cliStorageRoot: string): string {
  return join(cliStorageRoot, "agents");
}

export function getPluginStorageRoot(cliStorageRoot: string): string {
  return join(cliStorageRoot, "plugins");
}

export function getModelIoDir(cliStorageRoot: string, isDevelopment: boolean): string {
  return join(cliStorageRoot, isDevelopment ? "debug" : "rollout");
}

export function getProjectMemoryRoot(
  cliStorageRoot: string,
  workingDirectory: string,
  workspaceIdentity?: string,
): string {
  return resolveProjectMemoryRoot({
    cliStorageRoot,
    workspaceIdentity,
    workspacePath: workingDirectory,
  });
}

export function projectIdFromDirectory(directory: string): ProjectId {
  return createProjectId(
    directory
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "default",
  );
}
