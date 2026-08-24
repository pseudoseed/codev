export function encodeScope(paths: string[]): string {
  return paths.map((p) => encodeURIComponent(p)).join(',');
}
