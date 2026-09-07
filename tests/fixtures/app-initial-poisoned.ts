export function aaaPoisonedExport() {}

Object.defineProperty(aaaPoisonedExport, Symbol.toPrimitive, {
  value() {
    throw new TypeError("String is not a function");
  },
});

// Desktop exports the RPC client class before its factory. Both mention
// getRemoteMain, but only the factory can be called without `new`.
export class bbbRemoteMainClient {
  getRemoteMain() {
    return {};
  }
}

export function zzzCreateRemoteMain() {
  const getRemoteMain = () => ({
    services: Promise.resolve({
      clientCoordination: {
        threadQueuedFollowUpsChanged(payload: unknown) {
          return payload;
        },
      },
    }),
  });
  return getRemoteMain();
}
