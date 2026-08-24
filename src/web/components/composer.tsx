import { useState, type FocusEvent, type FormEvent, type KeyboardEvent } from "react";
import type { ModelOption, PermissionOption } from "../state/use-codex";

export type ComposerSettings = {
  model?: string;
  reasoningEffort?: string;
  permission?: string;
};

type ComposerProps = {
  onSend: (text: string) => Promise<void> | void;
  running: boolean;
  onStop?: () => Promise<void> | void;
  disabled?: boolean;
  models?: ModelOption[];
  permissions?: PermissionOption[];
  model?: string;
  reasoningEffort?: string;
  permission?: string;
  onSettingsChange?: (settings: ComposerSettings) => void;
};

export function Composer({
  onSend,
  running,
  onStop,
  disabled,
  models = [],
  permissions = [],
  model,
  reasoningEffort,
  permission,
  onSettingsChange,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [permissionOpen, setPermissionOpen] = useState(false);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const instruction = text.trim();
    if (!instruction || busy || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSend(instruction);
      setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send instruction");
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  async function stop() {
    if (!onStop || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onStop();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop task");
    } finally {
      setBusy(false);
    }
  }

  const selectedModel = models.find((option) => option.id === model);
  const selectedPermission = permissions.find((option) => option.id === permission);
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? (
    reasoningEffort ? [reasoningEffort] : []
  );
  const settingsDisabled = disabled || !onSettingsChange;

  return (
    <form className="composer" onSubmit={submit}>
      <label htmlFor="instruction" className="visually-hidden">Instruction</label>
      <textarea
        id="instruction"
        aria-label="Instruction"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={running ? "Add guidance while Codex works" : "What should Codex do next?"}
        rows={2}
        disabled={disabled}
      />
      {(models.length > 0 || permissions.length > 0 || model || permission) ? (
        <div className="composer-settings" aria-label="对话设置">
          <div
            className="permission-picker"
            onBlur={(event: FocusEvent<HTMLDivElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setPermissionOpen(false);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setPermissionOpen(false);
            }}
          >
            <button
              type="button"
              className="permission-trigger"
              aria-label={`权限：${selectedPermission?.label ?? permission ?? "未选择"}`}
              aria-haspopup="listbox"
              aria-expanded={permissionOpen}
              disabled={settingsDisabled}
              onClick={() => setPermissionOpen((current) => !current)}
            >
              {selectedPermission?.label ?? permission ?? "权限"}
              <span aria-hidden="true">⌄</span>
            </button>
            {permissionOpen ? (
              <div className="permission-options" role="listbox" aria-label="权限">
                {permissions.map((option) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.id === permission}
                    className="permission-option"
                    key={option.id}
                    onClick={() => {
                      setPermissionOpen(false);
                      onSettingsChange?.({ model, reasoningEffort, permission: option.id });
                    }}
                  >
                    <span className="permission-option-copy">
                      <strong>{option.label}</strong>
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                    {option.id === permission ? <span aria-hidden="true">✓</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <label>
            <span>模型</span>
            <select
              aria-label="模型"
              value={model ?? ""}
              disabled={settingsDisabled}
              onChange={(event) => {
                const nextModel = models.find((option) => option.id === event.target.value);
                const nextEffort = nextModel?.reasoningEfforts.includes(reasoningEffort ?? "")
                  ? reasoningEffort
                  : nextModel?.defaultReasoningEffort;
                onSettingsChange?.({ model: event.target.value, reasoningEffort: nextEffort, permission });
              }}
            >
              {model && !models.some((option) => option.id === model) ? <option value={model}>{model}</option> : null}
              {models.map((option) => <option key={option.id} value={option.id}>{option.displayName}</option>)}
            </select>
          </label>
          <label>
            <span>思考强度</span>
            <select
              aria-label="思考强度"
              value={reasoningEffort ?? ""}
              disabled={settingsDisabled}
              onChange={(event) => onSettingsChange?.({ model, reasoningEffort: event.target.value, permission })}
            >
              {reasoningEfforts.map((effort) => <option key={effort} value={effort}>{reasoningLabel(effort)}</option>)}
            </select>
          </label>
        </div>
      ) : null}
      <div className="composer-actions">
        <span className="composer-hint">⌘↵ to send</span>
        {running && onStop ? (
          <button className="stop-button" type="button" onClick={stop} disabled={busy}>
            Stop
          </button>
        ) : null}
        <button className="primary-button" type="submit" disabled={!text.trim() || busy || disabled}>
          {busy ? "Working…" : running ? "Steer" : "Send"}
        </button>
      </div>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </form>
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
