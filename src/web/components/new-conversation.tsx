import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { MobileLanguage } from "../../mobile/settings-store";
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
  language?: MobileLanguage;
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
  language = "zh-CN",
}: NewConversationProps) {
  const copy = newConversationCopy(language);
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
      setError(cause instanceof Error ? cause.message : copy.createFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="new-conversation" aria-labelledby="new-conversation-title">
      <div className="new-conversation-heading">
        <button type="button" className="back-button visible" onClick={onCancel} aria-label={copy.back}>‹</button>
        <div>
          <p className="eyebrow">New conversation</p>
          <h2 id="new-conversation-title">{copy.title}</h2>
        </div>
      </div>

      <form onSubmit={submit}>
        <label className="choice-field">
          <span>{copy.project}</span>
          <select
            aria-label={copy.project}
            value={cwd}
            onChange={(event) => {
              const nextCwd = event.target.value;
              setCwd(nextCwd);
              void onProjectChange?.(nextCwd);
            }}
          >
            <option value="">{copy.direct}</option>
            {projects.map((project) => (
              <option value={project.cwd} key={project.cwd}>{project.name}</option>
            ))}
          </select>
          <small>{cwd ? copy.projectHint : copy.directHint}</small>
        </label>

        <label className="choice-field">
          <span>{copy.permission}</span>
          <select aria-label={copy.permission} value={permission} onChange={(event) => setPermission(event.target.value)} disabled={catalogLoading}>
            {permissions.map((option) => (
              <option value={option.id} key={option.id}>{option.label}</option>
            ))}
          </select>
          <small>{permissions.find((option) => option.id === permission)?.description ?? copy.permissionHint}</small>
        </label>

        <label className="choice-field">
          <span>{copy.model}</span>
          <select aria-label={copy.model} value={selectedModel?.id ?? ""} onChange={(event) => setModelId(event.target.value)} disabled={catalogLoading}>
            {models.map((model) => (
              <option value={model.id} key={model.id}>{model.displayName}</option>
            ))}
          </select>
        </label>

        <label className="choice-field">
          <span>{copy.reasoning}</span>
          <select aria-label={copy.reasoning} value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)} disabled={catalogLoading}>
            {(selectedModel?.reasoningEfforts ?? []).map((effort) => (
              <option value={effort} key={effort}>{reasoningLabel(effort, language)}</option>
            ))}
          </select>
        </label>

        {catalogError ? (
          <div className="catalog-error">
            <p className="inline-error" role="alert">{catalogError}</p>
            <button type="button" className="secondary-button" onClick={() => void onRetry?.(cwd)}>
              {copy.retry}
            </button>
          </div>
        ) : catalogLoading || models.length === 0 || permissions.length === 0 ? (
          <p className="inline-error" role="status">{copy.loading}</p>
        ) : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}

        <button
          type="submit"
          className="primary-button create-conversation-button"
          disabled={busy || catalogLoading || Boolean(catalogError) || !selectedModel || !permission || !reasoningEffort}
        >
          {busy ? copy.creating : copy.create}
        </button>
      </form>
    </section>
  );
}

function reasoningLabel(value: string, language: MobileLanguage = "zh-CN") {
  if (language === "en") return value === "xhigh" ? "Extra high" : value[0].toUpperCase() + value.slice(1);
  if (value === "low") return "低";
  if (value === "medium") return "中";
  if (value === "high") return "高";
  if (value === "xhigh") return "很高";
  if (value === "max") return "最大";
  if (value === "ultra") return "Ultra";
  return value;
}

function newConversationCopy(language: MobileLanguage) {
  const en = language === "en";
  return {
    back: en ? "Back to conversations" : "返回对话列表",
    title: en ? "New conversation" : "新对话",
    project: en ? "Project" : "项目",
    direct: en ? "Direct conversation" : "直接对话",
    projectHint: en ? "Run in the selected project directory" : "在所选项目目录中运行",
    directHint: en ? "Use the service default directory without assigning a project" : "使用服务默认目录，不归入指定项目",
    permission: en ? "Permission" : "权限",
    permissionHint: en ? "Sensitive actions can still be controlled through approvals" : "可在后续审批中继续控制敏感操作",
    model: en ? "Model" : "模型",
    reasoning: en ? "Reasoning effort" : "思考强度",
    retry: en ? "Retry" : "重试读取",
    loading: en ? "Loading models and permissions from this Mac…" : "正在读取本机模型和权限…",
    create: en ? "Create conversation" : "创建对话",
    creating: en ? "Creating…" : "正在创建…",
    createFailed: en ? "Failed to create conversation" : "创建对话失败",
  };
}
