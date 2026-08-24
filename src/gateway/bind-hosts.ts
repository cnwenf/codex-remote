export function parseAdditionalBindHosts(value: string | undefined): string[] {
  return [...new Set(
    (value ?? "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
  )];
}
