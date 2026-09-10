// Bundled only for opt-in Android instrumentation; never included in the app.
import { CodexSocket, uploadImage } from "../../src/web/api/socket";
import { uploadNativeImage } from "../../src/mobile/native-image-upload";

const state = { ready: false, selected: 0, phase: "idle", uploads: [] as { source: number; stored: number; elapsedMs: number }[], legacy: "pending", error: "" };
Object.assign(window, { imageProbe: state });
const socket = new CodexSocket();
void socket.connect("e2e-token", "ws://127.0.0.1:4319/rpc", true).then(() => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.id = "image-probe-input";
  input.style.cssText = "position:fixed;top:20px;left:20px;width:280px;height:100px;z-index:2147483647;background:white";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    state.selected++;
    state.phase = "upload";
    const started = performance.now();
    if (state.uploads.length === 0) {
      void uploadNativeImage("http://127.0.0.1:4319", "e2e-token", file).then(() => {
        state.legacy = "unexpected-success";
      }, () => { state.legacy = "failed"; });
    }
    void uploadImage(file, fetch, { imageUploader: (image) => socket.uploadImage(image) }).then(async (image) => {
      state.phase = "download";
      const response = await fetch(`http://127.0.0.1:4319/api/images/${image.id}`, {
        headers: { authorization: "Bearer e2e-token" },
      });
      if (!response.ok || (await response.arrayBuffer()).byteLength !== image.size) throw new Error("roundtrip-mismatch");
      state.phase = "send";
      await socket.request("thread/resume", { threadId: "fixture-thread" }, { timeoutMs: 5_000 });
      const turn = await socket.request("turn/start", { threadId: "fixture-thread", input: [
        { type: "text", text: "Android image network regression" }, { type: "remoteImage", id: image.id },
      ] }, { timeoutMs: 5_000 }) as { turn?: { id?: string } };
      if (!turn.turn?.id) throw new Error("image-message-not-started");
      state.uploads.push({ source: file.size, stored: image.size, elapsedMs: Math.round(performance.now() - started) });
      input.value = "";
    }).catch(() => { state.error = "socket-upload-failed"; });
  };
  document.body.append(input);
  state.ready = true;
}).catch(() => { state.error = "socket-connect-failed"; });
