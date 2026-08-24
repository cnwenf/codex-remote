import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CreateThreadOptions,
  ModelOption,
  PermissionOption,
} from "../state/use-codex";

type ProjectOption = { cwd: string; name: string };

type NewConversationProps = {
  projects: ProjectOption[];
  models: ModelOption[];
  permissions: PermissionOption[];
  catalogLoading?: boolean;
  catalogError?: string;
  onProjectChange?: (cwd: string) => void | Promise<unknown>;
  onRetry?: (cwd: string) => void | Promise<unknown>;
  onCreate: (options: CreateThreadOptions) => void | Promise<unknown>;
  onCancel: () => void;
};

export function NewConversation({
  projects,
  models,
  permissions,
  catalogLoading,
  catalogError,
  onProjectChange,
  onRetry,
  onCreate,
  onCancel,
}: NewConversationProps) {
  const [cwd, setCwd] = useState("");
  const [modelId, setModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [permission, setPermission] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const selectedModel = useMemo(
    () => models.find((model) => model.id === modelId) ?? models[0],
    [modelId, models],
  );

  useEffect(() => {
    if (!modelId && models[0]) setModelId(models[0].id);
  }, [modelId, models]);

  useEffect(() => {
    if (!selectedModel) return;
    if (!selectedModel.reasoningEfforts.includes(reasoningEffort)) {
      setReasoningEffort(selectedModel.defaultReasoningEffort);
    }
  }, [reasoningEffort, selectedModel]);

  useEffect(() => {
    if (permission && permissions.some((option) => option.id === permission)) return;
    const preferred = permissions.find((option) => option.id === "auto") ?? permissions[0];
    setPermission(preferred?.id ?? "");
  }, [permission, permissions]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (catalogError || catalogLoading || !selectedModel || !permission || !reasoningEffort) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({
        ...(cwd ? { cwd } : {}),
        permission,
        model: selectedModel.id,
        reasoningEffort,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建对话失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="new-conversation" aria-labelledby="new-conversation-title">
      <div className="new-conversation-heading">
        <button type="button" className="back-button visible" onClick={onCancel} aria-label="返回对话列表">‹</button>
        <div>
          <p className="eyebrow">New conversation</p>
          <h2 id="new-conversation-title">新对话</h2>
        </div>
      </div>

      <form onSubmit={submit}>
        <label className="choice-field">
          <span>项目</span>
          <select
            aria-label="项目"
            value={cwd}
            onChange={(event) => {
              const nextCwd = event.target.value;
              setCwd(nextCwd);
              void onProjectChange?.(nextCwd);
            }}
          >
            <option value="">直接对话</option>
            {projects.map((project) => (
              <option value={project.cwd} key={project.cwd}>{project.name}</option>
            ))}
          </select>
          <small>{cwd ? "在所选项目目录中运行" : "使用服务默认目录，不归入指定项目"}</small>
        </label>

        <label className="choice-field">
          <span>权限</span>
          <select aria-label="权限" value={permission} onChange={(event) => setPermission(event.target.value)} disabled={catalogLoading}>
            {permissions.map((option) => (
              <option value={option.id} key={option.id}>{option.label}</option>
            ))}
          </select>
          <small>{permissions.find((option) => option.id === permission)?.description ?? "可在后续审批中继续控制敏感操作"}</small>
        </label>

        <label className="choice-field">
          <span>模型</span>
          <select aria-label="模型" value={selectedModel?.id ?? ""} onChange={(event) => setModelId(event.target.value)} disabled={catalogLoading}>
            {models.map((model) => (
              <option value={model.id} key={model.id}>{model.displayName}</option>
            ))}
          </select>
        </label>

        <label className="choice-field">
          <span>思考强度</span>
          <select aria-label="思考强度" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)} disabled={catalogLoading}>
            {(selectedModel?.reasoningEfforts ?? []).map((effort) => (
              <option value={effort} key={effort}>{reasoningLabel(effort)}</option>
            ))}
          </select>
        </label>

        {catalogError ? (
          <div className="catalog-error">
            <p className="inline-error" role="alert">{catalogError}</p>
            <button type="button" className="secondary-button" onClick={() => void onRetry?.(cwd)}>
              重试读取
            </button>
          </div>
        ) : catalogLoading || models.length === 0 || permissions.length === 0 ? (
          <p className="inline-error" role="status">正在读取本机模型和权限…</p>
        ) : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}

        <button
          type="submit"
          className="primary-button create-conversation-button"
          disabled={busy || catalogLoading || Boolean(catalogError) || !selectedModel || !permission || !reasoningEffort}
        >
          {busy ? "正在创建…" : "创建对话"}
        </button>
      </form>
    </section>
  );
}

function reasoningLabel(value: string) {
  if (value === "low") return "低";
  if (value === "medium") return "中";
  if (value === "high") return "高";
  if (value === "xhigh") return "很高";
  if (value === "max") return "最大";
  if (value === "ultra") return "Ultra";
  return value;
}
