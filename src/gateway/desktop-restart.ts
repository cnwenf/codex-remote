import { execFile as nodeExecFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";

type ExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export function createDesktopRestarter(options: {
  scriptPath: string;
  execFile?: ExecFile;
}) {
  const execFile = options.execFile ?? nodeExecFile as ExecFile;
  return () => new Promise<void>((resolve, reject) => {
    execFile(options.scriptPath, ["--execute"], {
      timeout: 90_000,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: process.env,
    }, (error) => error ? reject(error) : resolve());
  });
}
