/**
 * Render-contract tests. The plugin code blocks render with React Native at
 * runtime (not unit-testable in Node), so these tests pin the CONTRACTS in the
 * renderer source that keep regressing: explicit monospace on every code token
 * (nested react-native-web Texts do not inherit fontFamily), no-wrap code with
 * horizontal scroll, and the solid black code background.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as path from "node:path";
const rendererSource = String(readFileSync(path.resolve("client/markdown.tsx"), "utf8"));
const webSource = String(readFileSync(path.resolve("client/web.ts"), "utf8"));

test("every code token Text carries the monospace family explicitly", () => {
  // react-native-web nested Texts do NOT inherit fontFamily: each token must
  // set it or the code block silently renders proportional again.
  assert.match(rendererSource, /<Text key=\{tokenIndex\} style=\{\[mono, \{ color: darkPalette/);
  assert.match(rendererSource, /\[\s*mono,\s*nowrap,/);
});

test("code blocks scroll horizontally and never wrap", () => {
  assert.match(rendererSource, /<ScrollView horizontal showsHorizontalScrollIndicator/);
  assert.match(rendererSource, /flexDirection: "row"/);
  assert.match(rendererSource, /whiteSpace: "pre"/);
});

test("code blocks render on a solid black background with the custom palette", () => {
  assert.match(rendererSource, /backgroundColor: "#000000"/);
  assert.match(rendererSource, /const darkPalette = \{/);
  for (const token of ["plain", "keyword", "string", "comment", "number", "function", "type", "added", "removed", "meta", "tag"]) {
    assert.match(rendererSource, new RegExp(token + ": \"#"));
  }
});

test("inline code chips keep accent color, padding and monospace", () => {
  // the inline code case must include the monospace stack and surface2 chip
  const codeCase = String(rendererSource).slice(
    rendererSource.indexOf('case "code"'),
    rendererSource.indexOf('case "break"'),
  );
  assert.match(codeCase, /monospaceFont\(\)/);
  assert.match(codeCase, /paddingHorizontal: 5/);
  assert.match(codeCase, /theme\.colors\.accent/);
});

test("paragraph pressables never register onLongPress (native selection stays native)", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.ok(!timelineSource.includes("onLongPress"));
});

test("native paragraphs are selectable and double-tap driven (no Pressable wrapper)", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  // The native branch renders without a Pressable (a Pressable cancels the
  // platform selection on long-press) and wires the double-tap handler.
  assert.ok(timelineSource.includes('layout.platform === "web"'));
  assert.ok(timelineSource.includes("onChunkPress"));
  assert.ok(timelineSource.includes("selectable"));
  assert.ok(timelineSource.includes("handleChunkTap"));
});

test("downloads stream chunks instead of accumulating a data URI", () => {
  const panelSource = String(readFileSync(path.resolve("client/panel.tsx")));
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  const downloadSource = String(readFileSync(path.resolve("client/file-download.ts")));
  assert.ok(!panelSource.includes("parts.push"));
  assert.ok(!timelineSource.includes("parts.push"));
  assert.ok(!panelSource.includes("data:application/octet-stream"));
  assert.ok(!timelineSource.includes("data:application/octet-stream"));
  assert.match(downloadSource, /length: FILE_TRANSFER_CHUNK_BYTES/);
  assert.match(downloadSource, /fileVersion/);
  assert.match(downloadSource, /await destination\.writeBase64\(result\.base64\)/);
});

test("file previews virtualize lines and highlight only rendered rows", () => {
  const panelSource = String(readFileSync(path.resolve("client/panel.tsx")));
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.match(rendererSource, /<FlatList/);
  assert.match(rendererSource, /initialNumToRender=\{40\}/);
  assert.match(rendererSource, /MAX_HIGHLIGHTED_LINE_LENGTH/);
  assert.ok(!panelSource.includes("forceShowAll"));
  assert.ok(!timelineSource.includes("forceShowAll"));
  assert.equal(panelSource.match(/virtualized/g)?.length, 1);
  assert.equal(timelineSource.match(/virtualized/g)?.length, 2);
});

test("external links open on the client and nested styles retain file handlers", () => {
  assert.ok(!rendererSource.includes("openInBrowserRpc"));
  assert.match(rendererSource, /if \(await openExternalUrlOnWeb\(url\)\) return/);
  assert.match(webSource, /web\.paseoDesktop\?\.opener\?\.openUrl/);
  assert.match(webSource, /web\.open\?\.\(url, "_blank", "noopener,noreferrer"\)/);
  assert.equal(rendererSource.match(/accessibilityRole="link"/g)?.length, 3);
  const boldCase = rendererSource.slice(rendererSource.indexOf('case "bold"'), rendererSource.indexOf('case "code"'));
  assert.equal(boldCase.match(/localFileResolver=\{localFileResolver\}/g)?.length, 3);
  assert.equal(boldCase.match(/onLocalFilePress=\{onLocalFilePress\}/g)?.length, 3);
});

test("plain user messages remain host-rendered so Paseo preserves attachments", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx"), "utf8"));
  const sharedSource = String(readFileSync(path.resolve("shared/review.ts"), "utf8"));
  const transformerStart = timelineSource.indexOf('id: "inline-review-sent"');
  const transformerEnd = timelineSource.indexOf(
    'client.addTimelineRenderer({\n    kind: "inline-review-sent"',
    transformerStart,
  );
  const transformer = timelineSource.slice(transformerStart, transformerEnd);
  assert.match(transformer, /if \(looksLikeSentReview\(item\.text\)\)/);
  assert.match(transformer, /return undefined/);
  assert.ok(!timelineSource.includes('kind: "user-message-card"'));
  assert.ok(!sharedSource.includes("userMessageCardSchema"));
});

test("timeline rows use scoped agent state and one elected wide-frame controller", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.ok(!timelineSource.includes("useSettings("));
  assert.ok(!timelineSource.includes("(agent) => agent)"));
  assert.match(timelineSource, /subscribeTurnIndex\(agentId, listener\)/);
  assert.match(timelineSource, /useWideFrameControllerOwner\(\)/);
});

test("assistant renderers never suppress host timeline rows", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  // The host virtualizes source rows and keeps their measured height even when
  // a plugin renderer returns null. Suppressing a streamed fragment therefore
  // creates a large blank gap and strands adjacent tool-call rows.
  assert.doesNotMatch(
    timelineSource,
    /presentation\.hidden[\s\S]{0,240}\?\s*null\s*:/,
  );
});

test("local markdown images load through the daemon and remain visible", () => {
  const branchStart = rendererSource.indexOf("const single = block.lines.length === 1");
  const singleImageBranch = rendererSource.slice(branchStart, branchStart + 2_000);
  assert.match(singleImageBranch, /localFileResolver\?\.\(token\.url\)/);
  assert.match(singleImageBranch, /<LocalMarkdownImage/);
  assert.match(singleImageBranch, /cardStyle=\{\[styles\.localImageCard, blockSpacing \?\? null\]\}/);
  assert.match(rendererSource, /mode: "image"/);
  assert.match(rendererSource, /source=\{\{ uri: dataUri \}\}/);
  assert.match(rendererSource, /localImageCard:[\s\S]{0,200}alignSelf: "flex-start"/);
  assert.match(rendererSource, /localImageCard:[\s\S]{0,400}backgroundColor: theme\.colors\.surface1/);
});

test("file preview panels render detected images instead of the binary fallback", () => {
  const panelSource = String(readFileSync(path.resolve("client/panel.tsx")));
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.match(panelSource, /state\.kind === "image"/);
  assert.match(panelSource, /<Image[\s\S]{0,200}source=\{\{ uri: state\.dataUri \}\}/);
  assert.match(timelineSource, /filePreview\.kind === "image"/);
  assert.match(timelineSource, /<Image[\s\S]{0,200}source=\{\{ uri: filePreview\.dataUri \}\}/);
});

test("streamed final fragments render as slices of one card", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.match(timelineSource, /getTurnFinalCardPosition/);
  assert.match(timelineSource, /cardBridge/);
  assert.match(timelineSource, /finalCardPosition === "start"/);
  assert.match(timelineSource, /finalCardPosition === "end"/);
});

test("file tabs are owned by one context and use the host's real tab close control", () => {
  const entrySource = String(readFileSync(path.resolve("index.client.tsx")));
  const panelSource = String(readFileSync(path.resolve("client/panel.tsx")));
  assert.match(entrySource, /target\.workspaceId === workspaceId && target\.agentId === agentId/);
  assert.match(panelSource, /target\.agentId !== agentId \|\| target\.workspaceId !== workspaceId/);
  assert.ok(!panelSource.includes("Close the file preview"));
  assert.ok(!panelSource.includes("✕ Close"));
});

test("download actions are hidden outside the web platform", () => {
  const panelSource = String(readFileSync(path.resolve("client/panel.tsx")));
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  const nativePreviewStart = timelineSource.indexOf('<Modal\n          title="File preview"');
  const nativePreviewEnd = timelineSource.indexOf("</Modal>", nativePreviewStart);
  const nativePreview = timelineSource.slice(nativePreviewStart, nativePreviewEnd);
  assert.match(panelSource, /const canDownload = Platform\.OS === "web"/);
  assert.equal(panelSource.match(/\{canDownload \? \(/g)?.length, 2);
  assert.ok(nativePreviewStart >= 0 && nativePreviewEnd > nativePreviewStart);
  assert.ok(!nativePreview.includes(">Download</Text>"));
});

test("wide-frame mutation handling narrows text nodes to their parent element", () => {
  const wideFrameSource = String(readFileSync(path.resolve("client/wide-frame.ts")));
  assert.match(wideFrameSource, /node\.style && node\.dataset \? \(node as WNode\) : node\.parentElement/);
  assert.ok(!wideFrameSource.includes("schedule(n)"));
});
