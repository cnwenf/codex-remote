import { createServer } from "node:net";

type TestGatewayTarget = {
  host: string;
  port: number;
};

const PRODUCTION_GATEWAY_PORT = 4321;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export async function verifyAndroidTestGateway({ host, port }: TestGatewayTarget) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("android-test-gateway-must-use-loopback");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("android-test-gateway-port-invalid");
  }
  if (port === PRODUCTION_GATEWAY_PORT) {
    throw new Error("android-test-gateway-production-port-forbidden");
  }

  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    const fail = (cause: NodeJS.ErrnoException) => {
      probe.close();
      if (cause.code === "EADDRINUSE") {
        reject(new Error("android-test-gateway-port-in-use"));
        return;
      }
      reject(cause);
    };
    probe.once("error", fail);
    probe.listen(port, host, () => {
      probe.off("error", fail);
      probe.close((cause) => cause ? reject(cause) : resolve());
    });
  });
}
