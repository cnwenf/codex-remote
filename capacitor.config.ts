import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.cnwenf.codexremote",
  appName: "Codex Remote",
  webDir: "dist",
  backgroundColor: "#17130f",
  android: {
    allowMixedContent: true,
  },
  ios: {
    contentInset: "automatic",
    allowsLinkPreview: false,
  },
  plugins: {
    App: {
      disableBackButtonHandler: false,
    },
    LocalNotifications: {
      smallIcon: "ic_stat_codex_remote",
      iconColor: "#34A853",
    },
  },
};

export default config;
