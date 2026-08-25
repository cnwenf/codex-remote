const appIconUrl = new URL("../../../assets/app-icon.png", import.meta.url).href;

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "brand-mark brand-mark-compact" : "brand-mark"} aria-hidden="true">
      <img src={appIconUrl} alt="" />
    </span>
  );
}
