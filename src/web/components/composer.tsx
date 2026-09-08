import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { ModelOption, PermissionOption } from "../state/use-codex";
import type { MobileLanguage } from "../../mobile/settings-store";
import { MAX_TRANSFER_IMAGE_BYTES } from "../../protocol/image-transfer";
import { inspectImageFile, MAX_BROWSER_IMAGE_PIXELS } from "../api/image-metadata";

export type ComposerSettings = {
  model?: string;
  reasoningEffort?: string;
  permission?: string;
};

type ComposerProps = {
  draftKey?: string;
  onSend: (text: string, images: File[]) => Promise<void> | void;
  running: boolean;
  runningMode?: "queue" | "steer";
  onStop?: () => Promise<void> | void;
  disabled?: boolean;
  models?: ModelOption[];
  permissions?: PermissionOption[];
  model?: string;
  reasoningEffort?: string;
  permission?: string;
  onSettingsChange?: (settings: ComposerSettings) => Promise<void> | void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  language?: MobileLanguage;
};

type SelectedImage = { file: File; pixels: number };

export function Composer({
  draftKey,
  onSend,
  running,
  runningMode = "steer",
  onStop,
  disabled,
  models = [],
  permissions = [],
  model,
  reasoningEffort,
  permission,
  onSettingsChange,
  expanded,
  onExpandedChange,
  language,
}: ComposerProps) {
  const english = language === "en";
  const chinese = language === "zh-CN";
  const [text, setText] = useState(() => readDraft(draftKey));
  const activeDraftKey = useRef(draftKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [internalExpanded, setInternalExpanded] = useState(false);
  const [images, setImages] = useState<SelectedImage[]>([]);
  const imagesRef = useRef<SelectedImage[]>([]);
  const selectingRef = useRef(false);
  const selectionGeneration = useRef(0);
  const [selectingImages, setSelectingImages] = useState(false);
  const previews = useMemo(() => images.map(({ file }) => ({
    file,
    url: typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "",
  })), [images]);

  useEffect(() => () => {
    for (const preview of previews) {
      if (preview.url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(preview.url);
    }
  }, [previews]);

  useEffect(() => () => {
    selectionGeneration.current += 1;
  }, []);

  useEffect(() => {
    if (activeDraftKey.current === draftKey) return;
    activeDraftKey.current = draftKey;
    selectionGeneration.current += 1;
    selectingRef.current = false;
    setSelectingImages(false);
    setText(readDraft(draftKey));
    replaceImages([]);
    setError(undefined);
  }, [draftKey]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const instruction = text.trim();
    if ((!instruction && images.length === 0) || busy || selectingImages || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSend(instruction, images.map(({ file }) => file));
      setText("");
      writeDraft(draftKey, "");
      replaceImages([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send instruction");
    } finally {
      setBusy(false);
    }
  }

  async function addImages(files: File[]) {
    if (selectingRef.current) {
      setError("正在读取图片，请稍候");
      return;
    }
    selectingRef.current = true;
    setSelectingImages(true);
    const generation = selectionGeneration.current;
    try {
      const initial = imagesRef.current;
      const overflow = initial.length + files.length > 4;
      const filesToInspect = files.slice(0, Math.max(0, 4 - initial.length));
      const inspected: SelectedImage[] = [];
      for (const file of filesToInspect) {
        const { pixels } = await inspectImageFile(file);
        inspected.push({ file, pixels });
      }
      if (generation !== selectionGeneration.current) return;
      const current = imagesRef.current;
      const selected = inspected.slice(0, Math.max(0, 4 - current.length));
      const previewPixels = [...current, ...selected].reduce((total, image) => total + image.pixels, 0);
      if (previewPixels > MAX_BROWSER_IMAGE_PIXELS) {
        setError("最多同时预览 3200 万像素的图片");
        return;
      }
      if (selected.length > 0) replaceImages([...current, ...selected]);
      setError(overflow || current.length + files.length > 4 ? "最多添加 4 张图片" : undefined);
    } catch (cause) {
      if (generation === selectionGeneration.current) {
        setError(cause instanceof Error ? cause.message : "无法读取图片尺寸，请重新选择图片");
      }
    } finally {
      if (generation === selectionGeneration.current) {
        selectingRef.current = false;
        setSelectingImages(false);
      }
    }
  }

  function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    void addImages(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (pasted.length > 0) void addImages(pasted);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
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

  async function updateSettings(settings: ComposerSettings) {
    setError(undefined);
    const requestedDraftKey = draftKey;
    try {
      await onSettingsChange?.(settings);
    } catch (cause) {
      if (activeDraftKey.current !== requestedDraftKey) return;
      setError(cause instanceof Error ? cause.message : "更新对话设置失败");
    }
  }

  const selectedModel = models.find((option) => option.id === model);
  const selectedPermission = permissions.find((option) => option.id === permission);
  const reasoningEfforts = selectedModel?.reasoningEfforts ?? (
    reasoningEffort ? [reasoningEffort] : []
  );
  const settingsDisabled = disabled || !onSettingsChange;
  const isExpanded = expanded ?? internalExpanded;

  function setExpanded(next: boolean) {
    if (expanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
  }

  return (
    <form className={`composer ${isExpanded ? "composer-expanded" : "composer-collapsed"}`} onSubmit={submit}>
      <label htmlFor="instruction" className="visually-hidden">Instruction</label>
      <textarea
        id="instruction"
        aria-label="Instruction"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          writeDraft(draftKey, event.target.value);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onFocus={() => setExpanded(true)}
        placeholder={running
          ? runningMode === "queue"
            ? english ? "Queue until the current turn finishes" : "发送后排队，当前任务完成后执行"
            : chinese ? "引导当前轮次" : "Add guidance while Codex works"
          : chinese ? "输入下一条消息" : "What should Codex do next?"}
        rows={isExpanded ? 3 : 1}
        disabled={disabled}
      />
      {isExpanded && previews.length > 0 ? (
        <>
          <div className="composer-images" aria-label="待发送图片">
            {previews.map(({ file, url }, index) => (
              <div className="composer-image" key={`${file.name}-${file.size}-${index}`}>
                {url ? <img src={url} alt="" /> : null}
                <span title={file.name}>{file.name}</span>
                <button
                  type="button"
                  aria-label={`移除 ${file.name}`}
                  onClick={() => replaceImages(imagesRef.current.filter((_, itemIndex) => itemIndex !== index))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {images.some(({ file }) => file.size > MAX_TRANSFER_IMAGE_BYTES) ? (
            <p className="composer-image-hint">大于 1 MB 的图片会自动生成静态传输副本，GIF 动图将变为静态图。</p>
          ) : null}
        </>
      ) : null}
      {isExpanded && (models.length > 0 || permissions.length > 0 || model || permission) ? (
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
                      void updateSettings({ model, reasoningEffort, permission: option.id });
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
                void updateSettings({ model: event.target.value, reasoningEffort: nextEffort, permission });
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
              onChange={(event) => void updateSettings({ model, reasoningEffort: event.target.value, permission })}
            >
              {reasoningEfforts.map((effort) => <option key={effort} value={effort}>{reasoningLabel(effort)}</option>)}
            </select>
          </label>
        </div>
      ) : null}
      <div className="composer-actions">
        {isExpanded ? <label className="image-picker" title="添加图片">
          <span aria-hidden="true">＋</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            aria-label="添加图片"
            onChange={handleImageChange}
            disabled={disabled || busy || selectingImages || images.length >= 4}
          />
        </label> : null}
        {isExpanded ? <span className="composer-hint">⌘↵ to send</span> : <span className="composer-hint" />}
        {isExpanded && running && onStop ? (
          <button className="stop-button" type="button" onClick={stop} disabled={busy}>
            Stop
          </button>
        ) : null}
        <button
          className="primary-button"
          type="submit"
          disabled={(!text.trim() && images.length === 0) || busy || selectingImages || disabled}
        >
          {busy
            ? chinese ? "发送中…" : "Working…"
            : running
              ? runningMode === "queue" ? english ? "Queue" : "排队" : chinese ? "引导" : "Steer"
              : chinese ? "发送" : "Send"}
        </button>
      </div>
      {isExpanded && error ? <p className="inline-error" role="alert">{error}</p> : null}
    </form>
  );

  function replaceImages(next: SelectedImage[]) {
    imagesRef.current = next;
    setImages(next);
  }
}

const DRAFT_STORAGE_PREFIX = "codex-remote:draft:v1:";
const MAX_DRAFT_LENGTH = 100_000;

function readDraft(key?: string) {
  if (!key || typeof localStorage === "undefined") return "";
  try {
    return (localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${key}`) ?? "").slice(0, MAX_DRAFT_LENGTH);
  } catch {
    return "";
  }
}

function writeDraft(key: string | undefined, value: string) {
  if (!key || typeof localStorage === "undefined") return;
  try {
    const storageKey = `${DRAFT_STORAGE_PREFIX}${key}`;
    if (value) localStorage.setItem(storageKey, value.slice(0, MAX_DRAFT_LENGTH));
    else localStorage.removeItem(storageKey);
  } catch {
    // Draft persistence is best-effort when browser storage is unavailable.
  }
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
