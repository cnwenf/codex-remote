// @vitest-environment node

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const renderer = join(import.meta.dirname, "render-persistent-launch-agents.sh");
const manager = join(import.meta.dirname, "persistent-bridge.sh");
const stabilityVerifier = join(import.meta.dirname, "verify-persistent-bridge-stability.sh");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent LaunchAgent rendering", () => {
  it("renders an always-on Desktop job with loopback-only DevTools arguments", () => {
    const fixture = createFixture();
    const result = render(fixture);

    expect(result.status).toBe(0);
    const desktop = readPlist(join(fixture.output, "local.codex-web.desktop.plist"));
    expect(desktop).toMatchObject({
      Label: "local.codex-web.desktop",
      KeepAlive: true,
      RunAtLoad: true,
      LimitLoadToSessionType: "Aqua",
      ProcessType: "Interactive",
      ProgramArguments: [
        join(fixture.app, "Contents/MacOS/ChatGPT"),
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9229",
      ],
    });
  });

  it("renders a persistent gateway job without putting its access token in the plist", () => {
    const fixture = createFixture();
    const result = render(fixture);

    expect(result.status).toBe(0);
    const gatewayPath = join(fixture.output, "local.codex-web.gateway.plist");
    const source = readFileSync(gatewayPath, "utf8");
    const gateway = readPlist(gatewayPath);
    expect(gateway).toMatchObject({
      Label: "local.codex-web.gateway",
      KeepAlive: true,
      RunAtLoad: true,
      LimitLoadToSessionType: "Aqua",
      ProgramArguments: [
        join(fixture.project, "scripts/run-persistent-gateway.sh"),
        fixture.app,
        fixture.node,
        "192.168.1.20",
        "4321",
        "9229",
      ],
    });
    expect(source).not.toContain("test-access-token");
    expect(source).not.toContain("CODEX_WEB_TOKEN");
  });

  it("rejects a non-IPv4 bind host before writing a LaunchAgent", () => {
    const fixture = createFixture();
    const result = render(fixture, "host;touch /tmp/unsafe");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("bind host must be an IPv4 address");
  });
});

describe("persistent gateway launcher", () => {
  it("waits for Desktop and forwards the current bundled Codex version", () => {
    const fixture = createFixture();
    const bundledCodex = join(fixture.app, "Contents/Resources/codex");
    const gateway = join(fixture.root, "record-gateway.sh");
    const record = join(fixture.root, "gateway-args.txt");
    mkdirSync(join(fixture.app, "Contents/Resources"), { recursive: true });
    writeFileSync(bundledCodex, "#!/bin/sh\nprintf 'codex-cli 9.8.7\\n'\n");
    writeFileSync(gateway, `#!/bin/sh\nprintf 'node=%s\\n' "$CODEX_NODE_BIN" > ${JSON.stringify(record)}\nprintf '%s\\n' "$@" >> ${JSON.stringify(record)}\n`);
    chmodSync(bundledCodex, 0o700);
    chmodSync(gateway, 0o700);

    const result = spawnSync(
      "/bin/zsh",
      [
        join(import.meta.dirname, "run-persistent-gateway.sh"),
        fixture.app,
        fixture.node,
        "192.168.1.20",
        "4321",
        "9229",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_CURL_BIN: "/usr/bin/true",
          CODEX_RUN_GATEWAY_SCRIPT: gateway,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
      `node=${fixture.node}`,
      "http://127.0.0.1:9229",
      "9.8.7",
      "192.168.1.20",
      "4321",
      "127.0.0.1",
      "http://192.168.1.20:4321,http://127.0.0.1:4321",
    ]);
  });
});

describe("persistent bridge manager", () => {
  it("validates and renders a dry run without changing the user's LaunchAgents", () => {
    const fixture = createFixture();
    const bundledCodex = join(fixture.app, "Contents/Resources/codex");
    const desktop = join(fixture.app, "Contents/MacOS/ChatGPT");
    const launchAgents = join(fixture.root, "home", "Library", "LaunchAgents");
    mkdirSync(join(fixture.app, "Contents/Resources"), { recursive: true });
    writeFileSync(desktop, "#!/bin/sh\nexit 0\n");
    writeFileSync(bundledCodex, "#!/bin/sh\nprintf 'codex-cli 9.8.7\\n'\n");
    chmodSync(desktop, 0o700);
    chmodSync(bundledCodex, 0o700);

    const result = spawnSync("/bin/zsh", [manager, "--dry-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: join(fixture.root, "home"),
        CODEX_DESKTOP_APP_PATH: fixture.app,
        CODEX_NODE_BIN: fixture.node,
        BIND_HOST: "192.168.1.20",
        PORT: "4321",
        CODEX_LAUNCH_AGENTS_DIR: launchAgents,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Dry run passed; no LaunchAgents were changed.");
    expect(result.stdout).toContain("Web: http://192.168.1.20:4321");
    expect(() => readFileSync(join(launchAgents, "local.codex-web.desktop.plist"))).toThrow();
  });

  it("does not create inferred launchctl submit jobs from any shell script", () => {
    const shellSources = readdirSync(import.meta.dirname)
      .filter((name) => name.endsWith(".sh"))
      .map((name) => readFileSync(join(import.meta.dirname, name), "utf8"))
      .join("\n");
    expect(shellSources).not.toMatch(/\blaunchctl\s+submit\b/);
    expect(shellSources).not.toMatch(/\$LAUNCHCTL_BIN[^\n]*\bsubmit\b/);
    const managerSource = readFileSync(manager, "utf8");
    expect(managerSource).toContain('"$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$DESKTOP_PLIST"');
    expect(managerSource).toContain('"$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$GATEWAY_PLIST"');
  });
});

describe("persistent bridge stability verifier", () => {
  it("accepts stable persistent jobs when no installer job remains", () => {
    const fixture = createStabilityFixture(false);
    const result = verifyStability(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Persistent bridge stayed stable");
  });

  it("fails while an inferred installer job is still loaded", () => {
    const fixture = createStabilityFixture(true);
    const result = verifyStability(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("installer job is still loaded");
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-launch-agent-test-"));
  roots.push(root);
  const project = join(root, "project with spaces");
  const app = join(root, "ChatGPT Test.app");
  const node = join(root, "node");
  const output = join(root, "output");
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(output);
  writeFileSync(node, "#!/bin/sh\nexit 0\n");
  chmodSync(node, 0o700);
  return { root, project, app, node, output };
}

function render(fixture: ReturnType<typeof createFixture>, bindHost = "192.168.1.20") {
  return spawnSync(
    "/bin/zsh",
    [renderer, fixture.output, fixture.project, fixture.app, fixture.node, bindHost, "4321", "9229"],
    { encoding: "utf8", env: { ...process.env, CODEX_WEB_TOKEN: "test-access-token" } },
  );
}

function readPlist(path: string) {
  const result = spawnSync("plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function createStabilityFixture(installerLoaded: boolean) {
  const root = mkdtempSync(join(tmpdir(), "codex-stability-test-"));
  roots.push(root);
  const launchctl = join(root, "launchctl");
  const curl = join(root, "curl");
  const runtime = join(root, "runtime");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "persistent-install.log"), "finished\n");
  writeFileSync(
    launchctl,
    `#!/bin/sh
case "$2" in
  */local.codex-web.install-once) exit ${installerLoaded ? 0 : 113} ;;
  */local.codex-web.desktop) printf 'state = running\\nruns = 1\\npid = 111\\n' ;;
  */local.codex-web.gateway) printf 'state = running\\nruns = 1\\npid = 222\\n' ;;
  *) exit 113 ;;
esac
`,
  );
  writeFileSync(curl, "#!/bin/sh\nexit 0\n");
  chmodSync(launchctl, 0o700);
  chmodSync(curl, 0o700);
  return { root, launchctl, curl, runtime };
}

function verifyStability(fixture: ReturnType<typeof createStabilityFixture>) {
  return spawnSync("/bin/zsh", [stabilityVerifier, "0"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_LAUNCHCTL_BIN: fixture.launchctl,
      CODEX_CURL_BIN: fixture.curl,
      CODEX_RUNTIME_DIR: fixture.runtime,
      PORT: "4321",
      CODEX_DESKTOP_CDP_PORT: "9229",
    },
  });
}
