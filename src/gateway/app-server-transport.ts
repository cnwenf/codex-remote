import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  CodexTransport,
  RpcMessage,
  TransportDiagnostic,
} from "../protocol/types";

const MAX_JSONL_BUFFER = 2 * 1024 * 1024;

type AppServerTransportOptions = {
  binary: string;
  argsPrefix?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shutdownTimeoutMs?: number;
};

export class AppServerTransport implements CodexTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private onMessage: ((message: RpcMessage) => void) | undefined;
  private onDiagnostic: ((diagnostic: TransportDiagnostic) => void) | undefined;

  constructor(private readonly options: AppServerTransportOptions) {}

  async start(
    onMessage: (message: RpcMessage) => void,
    onDiagnostic: (diagnostic: TransportDiagnostic) => void,
  ): Promise<void> {
    if (this.child) throw new Error("app-server-already-started");
    this.onMessage = onMessage;
    this.onDiagnostic = onDiagnostic;

    const args = [
      ...(this.options.argsPrefix ?? []),
      "app-server",
      "--listen",
      "stdio://",
    ];
    const child = spawn(this.options.binary, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.onDiagnostic?.({
        category: "process",
        message: `app-server emitted ${chunk.byteLength} stderr bytes`,
      });
    });
    child.on("error", () => {
      this.onDiagnostic?.({
        category: "process",
        message: "app-server process error",
      });
    });
    child.on("exit", (code, signal) => {
      this.onDiagnostic?.({
        category: "process",
        message: `app-server exited (${signal ? "signal" : `code ${code ?? "unknown"}`})`,
      });
    });
  }

  send(message: RpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error("app-server-not-running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    child.kill("SIGTERM");
    const exited = await this.waitForExit(child, this.options.shutdownTimeoutMs ?? 2_000);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await this.waitForExit(child, this.options.shutdownTimeoutMs ?? 2_000);
    }
  }

  private consumeStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_JSONL_BUFFER) {
      this.stdoutBuffer = "";
      this.onDiagnostic?.({
        category: "protocol",
        message: "app-server frame exceeded size limit",
      });
      return;
    }

    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.parseLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private parseLine(line: string) {
    try {
      this.onMessage?.(JSON.parse(line) as RpcMessage);
    } catch {
      this.onDiagnostic?.({
        category: "protocol",
        message: "app-server emitted malformed JSON",
      });
    }
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }
}
