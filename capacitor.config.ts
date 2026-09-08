import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

const config: CapacitorConfig = {
  appId: "com.cnwenf.codexremote",
  appName: "Codex Remote",
  webDir: "dist",
  backgroundColor: "#17130f",
  android: {
    allowMixedContent: true,
    // Android already resizes with its Activity; enable the Keyboard bridge only on iOS.
    includePlugins: ["@capacitor/app", "@capacitor/local-notifications", "@capacitor/preferences"],
  },
  ios: {
    // The edge-to-edge Web layout owns safe areas, including after keyboard focus.
    contentInset: "never",
    // Scroll inside the Web page's dedicated panes, not the outer WKWebView.
    scrollEnabled: false,
    allowsLinkPreview: false,
  },
  plugins: {
    Keyboard: {
      resize: KeyboardResize.Native,
    },
    App: {
      disableBackButtonHandler: false,
    },
    LocalNotifications: {
      smallIcon: "ic_stat_codex_remote",
      iconColor: "#000000",
    },
  },
};

export default config;
