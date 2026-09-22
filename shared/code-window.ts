export function codeHighlightWindow(code: string, expanded: boolean, visibleLines = 40): {
  code: string;
  totalLines: number;
  visibleLines: number;
  collapsed: boolean;
} {
  let totalLines = 1;
  let prefixEnd = -1;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) !== 10) continue;
    if (totalLines === visibleLines && prefixEnd === -1) prefixEnd = index;
    totalLines += 1;
  }
  const collapsed = !expanded && totalLines > visibleLines;
  return {
    code: collapsed && prefixEnd >= 0 ? code.slice(0, prefixEnd) : code,
    totalLines,
    visibleLines: collapsed ? visibleLines : totalLines,
    collapsed,
  };
}
