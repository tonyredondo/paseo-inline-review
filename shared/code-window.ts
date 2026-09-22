export function codeHighlightWindow(code: string, expanded: boolean, visibleLines = 40): {
  code: string;
  totalLines: number;
  visibleLines: number;
  collapsed: boolean;
} {
  const lines = code.split("\n");
  const collapsed = !expanded && lines.length > visibleLines;
  const selected = collapsed ? lines.slice(0, visibleLines) : lines;
  return { code: selected.join("\n"), totalLines: lines.length, visibleLines: selected.length, collapsed };
}
