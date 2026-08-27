import { useRef, type ReactNode, type TouchEvent } from "react";
import type { MobileUpdateArtifact, MobileUpdateStatus } from "./app-update";
import { mobileCopy } from "./mobile-copy";
import type { MobileSettings } from "./settings-store";

export function SettingsPage({
  settings,
  currentVersion,
  updateStatus,
  onCheckUpdate,
  onDownloadUpdate,
  onChange,
  onBack,
}: {
  settings: MobileSettings;
  currentVersion?: string;
  updateStatus?: MobileUpdateStatus;
  onCheckUpdate?(): void;
  onDownloadUpdate?(artifact: MobileUpdateArtifact): void;
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

        {currentVersion && updateStatus && onCheckUpdate && onDownloadUpdate ? (
          <section className="mobile-update-section" aria-labelledby="software-update-heading">
            <h2 id="software-update-heading">{copy.softwareUpdate}</h2>
            <p>{copy.softwareUpdateDescription}</p>
            <div className="mobile-update-card">
              <div className="mobile-update-version-row">
                <span>{copy.currentVersion}</span>
                <strong>v{currentVersion}</strong>
              </div>
              {updateStatus.state === "available" ? (
                <div className="mobile-update-version-row mobile-update-latest-row">
                  <span>{copy.latestVersion}</span>
                  <strong>v{updateStatus.latestVersion}</strong>
                </div>
              ) : null}
              {updateStatus.state === "current" ? <p className="mobile-update-status">{copy.upToDate}</p> : null}
              {updateStatus.state === "error" ? (
                <p className="mobile-update-status mobile-update-error" role="status">{updateStatus.message}</p>
              ) : null}
              {updateStatus.state === "downloading" ? (
                <div
                  className="mobile-settings-update-progress"
                  role="progressbar"
                  aria-label={copy.downloadingVersion(updateStatus.latestVersion)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={updateStatus.progress}
                >
                  <span style={{ width: `${updateStatus.progress}%` }} />
                  <small>{updateStatus.progress}%</small>
                </div>
              ) : null}
              {updateStatus.state === "installing" ? (
                <p className="mobile-update-status" role="status">{copy.preparingInstall}</p>
              ) : null}
              <div className="mobile-update-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={updateStatus.state === "checking" || updateStatus.state === "downloading" || updateStatus.state === "installing"}
                  onClick={onCheckUpdate}
                >
                  {updateStatus.state === "checking" ? copy.checking : copy.checkUpdate}
                </button>
                {updateStatus.state === "available" ? (
                  <button
                    type="button"
                    className="primary-button"
                    aria-label={copy.downloadVersion(updateStatus.latestVersion)}
                    onClick={() => {
                      if (!window.confirm(copy.updateConfirmation(updateStatus.latestVersion))) return;
                      onDownloadUpdate({
                        latestVersion: updateStatus.latestVersion,
                        downloadUrl: updateStatus.downloadUrl,
                        checksumUrl: updateStatus.checksumUrl,
                      });
                    }}
                  >{copy.downloadVersion(updateStatus.latestVersion)}</button>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}
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
