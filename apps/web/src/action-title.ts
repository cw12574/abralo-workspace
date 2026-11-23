/** Turns a provider tool name such as `create-project` into "Create project". */
export function actionTitle(tool: string) {
  const words = String(tool || '')
    .replace(/^mcp__[^_]+__/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()));
  if (!words.length) return 'Action';
  return words.join(' ').replace(/^./, (c) => c.toUpperCase());
}
