export function aaaPoisonedExport() {}

Object.defineProperty(aaaPoisonedExport, Symbol.toPrimitive, {
  value() {
    throw new TypeError("String is not a function");
  },
});

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
