import { useRef, type ReactNode, type TouchEvent } from "react";
import { mobileCopy } from "./mobile-copy";
import type { MobileSettings } from "./settings-store";

export function SettingsPage({
  settings,
  onChange,
  onBack,
}: {
  settings: MobileSettings;
  onChange(settings: MobileSettings): void;
  onBack(): void;
}) {
  const copy = mobileCopy(settings.language);
  const swipeOrigin = useRef<{ x: number; y: number } | null>(null);

  function beginSwipe(event: TouchEvent) {
    const touch = event.touches[0];
    swipeOrigin.current = touch && touch.clientX <= 40 ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function finishSwipe(event: TouchEvent) {
    const origin = swipeOrigin.current;
    swipeOrigin.current = null;
    const touch = event.changedTouches[0];
    if (!origin || !touch) return;
    const horizontal = touch.clientX - origin.x;
    const vertical = Math.abs(touch.clientY - origin.y);
    if (horizontal >= 72 && vertical <= Math.max(48, horizontal * 0.5)) onBack();
  }

  return (
    <main className="mobile-settings" onTouchStart={beginSwipe} onTouchEnd={finishSwipe}>
      <header className="mobile-settings-header">
        <button type="button" aria-label={copy.back} onClick={onBack}>‹</button>
        <h1>{copy.settings}</h1>
        <span aria-hidden="true" />
      </header>
      <div className="mobile-settings-content">
        <PreferenceGroup title={copy.appearance} description={copy.appearanceDescription}>
          <PreferenceOption
            name="theme"
            value="system"
            checked={settings.theme === "system"}
            label={copy.system}
            onChange={() => onChange({ ...settings, theme: "system" })}
          />
          <PreferenceOption name="theme" value="light" checked={settings.theme === "light"} label={copy.light} onChange={() => onChange({ ...settings, theme: "light" })} />
          <PreferenceOption name="theme" value="dark" checked={settings.theme === "dark"} label={copy.dark} onChange={() => onChange({ ...settings, theme: "dark" })} />
        </PreferenceGroup>

        <PreferenceGroup title={copy.language} description={copy.languageDescription}>
          <PreferenceOption name="language" value="zh-CN" checked={settings.language === "zh-CN"} label="简体中文" onChange={() => onChange({ ...settings, language: "zh-CN" })} />
          <PreferenceOption name="language" value="en" checked={settings.language === "en"} label="English" onChange={() => onChange({ ...settings, language: "en" })} />
        </PreferenceGroup>

        <PreferenceGroup title={copy.sendMode} description={copy.sendModeDescription}>
          <PreferenceOption
            name="messageSendMode"
            value="queue"
            checked={settings.messageSendMode === "queue"}
            label={copy.queue}
            detail={copy.queueDescription}
            onChange={() => onChange({ ...settings, messageSendMode: "queue" })}
          />
          <PreferenceOption
            name="messageSendMode"
            value="steer"
            checked={settings.messageSendMode === "steer"}
            label={copy.steer}
            detail={copy.steerDescription}
            onChange={() => onChange({ ...settings, messageSendMode: "steer" })}
          />
        </PreferenceGroup>
      </div>
    </main>
  );
}

function PreferenceGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <fieldset className="mobile-preference-group" role="radiogroup" aria-label={title}>
      <legend>{title}</legend>
      <p>{description}</p>
      <div>{children}</div>
    </fieldset>
  );
}

function PreferenceOption({
  name,
  value,
  checked,
  label,
  detail,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  detail?: string;
  onChange(): void;
}) {
  return (
    <label className="mobile-preference-option">
      <span>
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} />
      <span className="preference-check" aria-hidden="true">✓</span>
    </label>
  );
}
