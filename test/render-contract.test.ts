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
const wideFrameMutationSource = String(readFileSync(path.resolve("client/wide-frame-mutations.ts"), "utf8"));

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

test("selected inline code lines fill the visible scroll viewport", () => {
  const inlineScrollSource = rendererSource.slice(
    rendererSource.indexOf("if (!wrapMode)"),
    rendererSource.indexOf("const webWrap"),
  );
  assert.match(inlineScrollSource, /contentContainerStyle=\{\{ minWidth: "100%" \}\}/);
  assert.match(inlineScrollSource, /paddingLeft: 10, minWidth: "100%"/);
  assert.match(inlineScrollSource, /backgroundColor: withAlpha\(theme\.colors\.accent, HIGHLIGHT_ALPHA\), alignSelf: "stretch"/);
});

test("code blocks render on a solid black background with the custom palette", () => {
  assert.match(rendererSource, /backgroundColor: "#000000"/);
  assert.match(rendererSource, /const darkPalette = \{/);
  for (const token of ["plain", "keyword", "string", "comment", "number", "function", "type", "added", "removed", "meta", "tag"]) {
    assert.match(rendererSource, new RegExp(token + ": \"#"));
  }
});

test("code copy controls own a full hit target above selectable code", () => {
  const copyButtonStyle = rendererSource.slice(
    rendererSource.indexOf("copyButton:"),
    rendererSource.indexOf("copyText:"),
  );
  assert.match(copyButtonStyle, /zIndex: 4/);
  assert.match(copyButtonStyle, /minWidth: 32/);
  assert.match(copyButtonStyle, /minHeight: 32/);
  assert.match(copyButtonStyle, /alignItems: "center"/);
  assert.match(copyButtonStyle, /justifyContent: "center"/);
  assert.match(rendererSource, /const WEB_COPY_BUTTON_STYLE/);
  assert.match(rendererSource, /cursor: "pointer"/);
  assert.equal(rendererSource.match(/pointerEvents="box-only"/g)?.length, 2);
  assert.equal(rendererSource.match(/hitSlop=\{6\}/g)?.length, 2);
  assert.doesNotMatch(rendererSource, /styles\.copyButton, \{ zIndex: 2/);
});

test("code selection excludes every line-number gutter and action label", () => {
  assert.match(rendererSource, /const WEB_NONSELECTABLE_STYLE = Platform\.OS === "web"/);
  assert.match(rendererSource, /WebkitUserSelect: "none"/);
  assert.equal(rendererSource.match(/WEB_NONSELECTABLE_STYLE/g)?.length, 7);
  assert.equal(rendererSource.match(/selectable=\{false\}/g)?.length, 7);
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

test("review affordance documents desktop code-line comments without promising them on touch", () => {
  const pillsSource = String(readFileSync(path.resolve("client/pills.tsx")));
  assert.match(pillsSource, /Cmd\+Click a paragraph or code line on desktop/);
  assert.match(pillsSource, /double-tap a paragraph on mobile or tablet/);
});

test("downloads stream chunks instead of accumulating a data URI", () => {
  const panelSource = String(readFileSync(path.resolve("client/panel.tsx")));
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  const downloadSource = String(readFileSync(path.resolve("client/file-download.ts")));
  assert.ok(!panelSource.includes("parts.push"));
  assert.ok(!timelineSource.includes("parts.push"));
  assert.ok(!panelSource.includes("data:application/octet-stream"));
  assert.ok(!timelineSource.includes("data:application/octet-stream"));
  assert.match(downloadSource, /length: chunkBytes/);
  assert.match(downloadSource, /chunkBytes = DESKTOP_FILE_TRANSFER_CHUNK_BYTES/);
  assert.match(panelSource, /COMPACT_FILE_TRANSFER_CHUNK_BYTES/);
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

test("expanded large inline code blocks virtualize rendered rows", () => {
  assert.match(rendererSource, /showAll && lines\.length > 200/);
  assert.match(rendererSource, /maxToRenderPerBatch=\{40\}/);
  assert.match(rendererSource, /codeHighlightWindow\(code, showAll, CODE_COLLAPSE_LINES\)/);
});

test("external links open on the client and nested styles retain file handlers", () => {
  assert.ok(!rendererSource.includes("openInBrowserRpc"));
  assert.match(rendererSource, /if \(await openExternalUrlOnWeb\(url\)\) return/);
  assert.match(webSource, /web\.paseoDesktop\?\.opener\?\.openUrl/);
  assert.match(webSource, /web\.open\?\.\(url, "_blank", "noopener,noreferrer"\)/);
  assert.equal(rendererSource.match(/accessibilityRole="link"/g)?.length, 2);
  const boldCase = rendererSource.slice(rendererSource.indexOf('case "bold"'), rendererSource.indexOf('case "code"'));
  assert.equal(boldCase.match(/localFileResolver=\{localFileResolver\}/g)?.length, 3);
  assert.equal(boldCase.match(/onLocalFilePress=\{onLocalFilePress\}/g)?.length, 3);
});

test("plain user messages use native cards without replacing web or attachment rows", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx"), "utf8"));
  const sharedSource = String(readFileSync(path.resolve("shared/review.ts"), "utf8"));
  const transformerStart = timelineSource.indexOf('id: "inline-review-sent"');
  const transformerEnd = timelineSource.indexOf(
    'client.addTimelineRenderer({\n    kind: "inline-review-sent"',
    transformerStart,
  );
  const transformer = timelineSource.slice(transformerStart, transformerEnd);
  assert.match(transformer, /if \(looksLikeSentReview\(item\.text\)\)/);
  assert.match(
    transformer,
    /if \(Platform\.OS === "web" \|\| userMessageHasHostAttachments\(item\)\) return undefined/,
  );
  assert.match(transformer, /kind: "user-message-card"/);
  assert.match(timelineSource, /kind: "user-message-card"[\s\S]{0,180}Component: UserMessageCard/);
  assert.match(sharedSource, /export const userMessageCardSchema/);
  assert.match(sharedSource, /export function userMessageHasHostAttachments/);
});

test("the compaction divider exposes the host-wide frame marker and a native dotted rule", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx"), "utf8"));
  const component = timelineSource.slice(
    timelineSource.indexOf("function CompactionDivider"),
    timelineSource.indexOf("function timestampLabel"),
  );
  assert.match(component, /<View testID="inline-review-root" style=\{styles\.root\}>/);
  assert.match(component, /layout\.platform === "web"/);
  assert.equal(component.match(/<CompactionRule /g)?.length, 2);

  const rule = timelineSource.slice(
    timelineSource.indexOf("const NATIVE_COMPACTION_DOTS"),
    timelineSource.indexOf("function CompactionDivider"),
  );
  assert.match(rule, /if \(platform === "web"\)/);
  assert.match(rule, /borderStyle: "dotted"/);
  assert.match(rule, /NATIVE_COMPACTION_DOTS = "● "/);
  assert.match(rule, /flex: 1/);
  assert.match(rule, /color: theme\.colors\.border/);
  assert.match(rule, /height: 9/);
  assert.match(rule, /fontSize: 9/);
  assert.match(rule, /lineHeight: 9/);
  assert.match(rule, /accessible=\{false\}/);
});

test("timeline renderers are available before transformers can replace native rows", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx"), "utf8"));
  const registrationSource = timelineSource.slice(timelineSource.indexOf("export function registerTimeline"));
  const registrations = [...registrationSource.matchAll(/client\.addTimeline(Renderer|Transformer)\(/g)]
    .map((match) => match[1]);
  const firstTransformer = registrations.indexOf("Transformer");
  assert.ok(firstTransformer > 0);
  assert.ok(
    registrations.slice(0, firstTransformer).every((kind) => kind === "Renderer"),
    `expected renderers first, got ${registrations.join(", ")}`,
  );
  assert.ok(
    registrations.slice(firstTransformer).every((kind) => kind === "Transformer"),
    `expected transformers last, got ${registrations.join(", ")}`,
  );
});

test("image user messages contain their controls and shrink within the timeline", () => {
  const wideFrameSource = String(readFileSync(path.resolve("client/wide-frame.ts")));
  assert.match(wideFrameSource, /const USER_CARD_IMAGE_OVERLAP = 6/);
  assert.match(wideFrameSource, /const USER_CARD_TEXT_VERTICAL_PADDING = 5/);
  assert.match(wideFrameSource, /const USER_CARD_CONTROLS_BOTTOM_PADDING = 8/);
  assert.match(wideFrameSource, /\[aria-label="Open image attachment"\]/);
  assert.match(wideFrameSource, /el\.style\.boxSizing = "border-box"/);
  assert.match(wideFrameSource, /cardBubble\.style\.display = "grid"/);
  assert.match(wideFrameSource, /cardBubble\.style\.gridTemplateColumns = "minmax\(0, 1fr\)"/);
  assert.match(wideFrameSource, /cardBubble\.style\.width = "100%"/);
  assert.match(wideFrameSource, /cardBubble\.style\.minWidth = "0px"/);
  assert.match(wideFrameSource, /imageRow\.style\.display = "flex"/);
  assert.match(wideFrameSource, /imageRow\.style\.flexWrap = "nowrap"/);
  assert.match(wideFrameSource, /imageRow\.style\.width = "max-content"/);
  assert.match(wideFrameSource, /imageRow\.style\.paddingTop = "5px"/);
  assert.match(wideFrameSource, /imageRow\.style\.marginBottom = "4px"/);
  assert.match(wideFrameSource, /image\.style\.flexShrink = "0"/);
  assert.match(wideFrameSource, /inlineReviewUserBackdrop = "1"/);
  assert.match(wideFrameSource, /backdrop\.style\.top/);
  assert.match(
    wideFrameSource,
    /Math\.max\(imageRow\.clientHeight - USER_CARD_IMAGE_OVERLAP, 0\)/,
  );
  assert.match(
    wideFrameSource,
    /el\.style\.paddingTop = "0px";\s+el\.style\.paddingBottom = `\$\{USER_CARD_CONTROLS_BOTTOM_PADDING\}px`/,
  );
  assert.match(
    wideFrameSource,
    /cardBubble\.style\.paddingTop = `\$\{USER_CARD_TEXT_VERTICAL_PADDING\}px`;\s+cardBubble\.style\.paddingBottom = `\$\{USER_CARD_TEXT_VERTICAL_PADDING\}px`/,
  );
  assert.match(wideFrameSource, /inlineReviewUserImages = "1"/);
  assert.match(
    wideFrameSource,
    /rootEl\.insertBefore\(backdrop, rootEl\.children\[0\] \?\? null\)/,
  );
  assert.doesNotMatch(wideFrameSource, /cardBubble\.insertBefore\(backdrop/);
  assert.match(wideFrameSource, /backdrop\.style\.right = "0px"/);
  assert.match(wideFrameSource, /backdrop\.style\.left = "0px"/);
  assert.match(wideFrameSource, /imageRow\.style\.paddingTop = ""/);
  assert.doesNotMatch(wideFrameSource, /imageRow\.style\.position = "absolute"/);
  assert.doesNotMatch(wideFrameSource, /el\.style\.marginTop = `\$\{/);
  assert.doesNotMatch(wideFrameSource, /insertBefore\(imageRow/);
});

test("timeline rows use scoped agent state and an imperatively elected wide-frame controller", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  const controllerSource = String(readFileSync(path.resolve("client/wide-frame-controller.tsx")));
  const settingsSource = String(readFileSync(path.resolve("client/wide-frame-settings.tsx")));
  const entrySource = String(readFileSync(path.resolve("client/plugin-entry.tsx")));
  assert.ok(!timelineSource.includes("useSettings("));
  assert.ok(!timelineSource.includes("(agent) => agent)"));
  assert.match(timelineSource, /turnFinalScopeKey\(host\.id, agentId\)/);
  assert.match(timelineSource, /subscribeTurnIndex\(turnScopeId, listener\)/);
  assert.doesNotMatch(timelineSource, /useWideFrameControllerOwner/);
  assert.match(timelineSource, /<WideFrameController[\s\S]{0,180}anchorRef=\{wideFrameAnchorRef\}/);
  assert.ok(
    timelineSource.indexOf("<FinalCardShell") < timelineSource.indexOf("<WideFrameController"),
    "the anchor-bearing card mounts before its imperative controller",
  );
  assert.match(controllerSource, /registerWideFrameOwner\(root, host\.id, \(active\) =>/);
  assert.match(controllerSource, /configureWideFrameLease\([\s\S]{0,180}value\.host\.id/);
  assert.match(controllerSource, /\n\s+anchorRef,\n/);
  assert.match(timelineSource, /rootRef=\{wideFrameAnchorRef\}/);
  assert.match(settingsSource, /configureWideFrameLease\([\s\S]{0,100}host\.id/);
  assert.doesNotMatch(settingsSource, /configureWideFrameLease\([\s\S]{0,100}\bnull,/);
  assert.match(controllerSource, /value\.settings\.status !== "ready"/);
  assert.match(entrySource, /const wideFrameLease = retainWideFrameLease\(\)/);
  assert.match(entrySource, /return async \(\) => \{[\s\S]{0,240}releaseWideFrameLease\(wideFrameLease\)/);
  assert.match(entrySource, /const removeSettingsScreen = client\.addSettingsScreen/);
  assert.match(entrySource, /removeSettingsScreen\(\)/);
});

test("turn finality subscriptions and fragment mounts run before paint", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  const assistant = timelineSource.slice(
    timelineSource.indexOf("function ReviewAssistantMessage"),
    timelineSource.indexOf("export function registerTimeline"),
  );
  assert.match(assistant, /useLayoutEffect\(\(\) => \{[\s\S]{0,240}retainTurnIndex/);
  assert.match(assistant, /useLayoutEffect\(\(\) => \{[\s\S]{0,240}mountTurnFinalFragment/);
});

test("wide-frame ownership is elected before the browser can paint", () => {
  const controllerSource = String(readFileSync(path.resolve("client/wide-frame-controller.tsx")));
  const controller = controllerSource.slice(
    controllerSource.indexOf("export function WideFrameController"),
  );
  assert.match(controller, /useLayoutEffect\(\(\) => \{[\s\S]{0,240}registerWideFrameOwner/);
  assert.doesNotMatch(controller, /useEffect\(\(\) => \{[\s\S]{0,240}registerWideFrameOwner/);
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

test("local markdown images load bounded thumbnails and full images stay explicit", () => {
  const branchStart = rendererSource.indexOf("const singleTokens = block.lines.length === 1");
  const singleImageBranch = rendererSource.slice(branchStart, branchStart + 2_000);
  assert.match(singleImageBranch, /localFileResolver\?\.\(token\.url\)/);
  assert.match(singleImageBranch, /<LocalMarkdownImage/);
  assert.match(singleImageBranch, /cardStyle=\{\[styles\.localImageCard, blockSpacing \?\? null\]\}/);
  assert.match(rendererSource, /useRpc\(localImagePreviewRpc\)/);
  assert.doesNotMatch(rendererSource, /mode: "image"/);
  assert.match(rendererSource, /retainImagePreview\(target\.path/);
  assert.match(rendererSource, /autoLoad: !compact/);
  assert.match(rendererSource, /const maxEdge = compact \? 320 : 640/);
  assert.match(rendererSource, /const quality = compact \? 65 : 78/);
  assert.match(rendererSource, /accessibilityLabel=\{state\.status === "loading" \? `Loading local image/);
  assert.match(rendererSource, /source=\{\{ uri: dataUri \}\}/);
  assert.match(rendererSource, />Open full image<\/Text>/);
  assert.match(rendererSource, /localImageCard:[\s\S]{0,200}alignSelf: "flex-start"/);
  assert.match(rendererSource, /localImageCard:[\s\S]{0,400}backgroundColor: theme\.colors\.surface1/);
});

test("compact remote markdown images wait for explicit interaction", () => {
  assert.match(rendererSource, /const \[loaded, setLoaded\] = useState\(!compact\)/);
  assert.match(rendererSource, /accessibilityLabel=\{`Load remote image/);
  assert.match(rendererSource, /onPress=\{\(\) => setLoaded\(true\)\}/);
});

test("file preview panels render detected images instead of the binary fallback", () => {
  const panelSource = String(readFileSync(path.resolve("client/panel.tsx")));
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.match(panelSource, /state\.kind === "image"/);
  assert.match(panelSource, /<Image[\s\S]{0,200}source=\{\{ uri: state\.dataUri \}\}/);
  assert.match(timelineSource, /filePreview\.kind === "image"/);
  assert.match(timelineSource, /<Image[\s\S]{0,200}source=\{\{ uri: filePreview\.dataUri \}\}/);
});

test("Markdown file tabs switch between source and an on-demand rendered preview", () => {
  const panelSource = String(readFileSync(path.resolve("client/panel.tsx")));
  assert.match(panelSource, /import \{ FileCodeBlock, MarkdownText \} from "\.\/markdown"/);
  assert.match(panelSource, /key=\{target\.requestId\}/);
  assert.match(panelSource, /useState<"source" \| "preview">\("source"\)/);
  assert.match(panelSource, /state\.kind === "text" && isMarkdownPath\(target\.path\)/);
  assert.match(panelSource, /accessibilityLabel=\{textView === "preview" \? "Show Markdown source" : "Preview rendered Markdown"\}/);
  assert.match(panelSource, /\{textView === "preview" \? "Source" : "Preview"\}/);
  assert.match(panelSource, /textView === "preview" && canPreviewMarkdown/);
  assert.match(panelSource, /<ScrollView[\s\S]{0,500}<MarkdownText/);
  assert.match(panelSource, /cacheKey=\{target\.path\}/);
  assert.match(panelSource, /localFileResolver=\{resolveMarkdownLink\}/);
  assert.match(panelSource, /onLocalFilePress=\{openMarkdownLink\}/);
});

test("code-line review keeps a text cursor while sharing Pressable events with its paragraph", () => {
  const markdownSource = String(readFileSync(path.resolve("client/markdown.tsx")));
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.match(markdownSource, /onCodeLinePress\?: \(anchor: CodeLineAnchor, event\?: unknown\) => void/);
  assert.match(markdownSource, /block\.kind === "code" \? nextCodeBlock\+\+ : -1/);
  assert.match(markdownSource, /createCodeLineAnchor\(block\.text, codeBlockIndex, lineIndex\)/);
  assert.equal(markdownSource.match(/onPress=\{linePress\(lineIndex/g)?.length, 3);
  assert.doesNotMatch(markdownSource, /onPointerUp=\{linePress\(lineIndex/);
  assert.equal(markdownSource.match(/<Pressable\s+[^>]*onPress=\{linePress\(lineIndex\)\}/gs)?.length, 3);
  assert.match(markdownSource, /const webLineText[\s\S]{0,160}cursor: "text"[\s\S]{0,40}userSelect: "text"/);
  const wrapSource = markdownSource.slice(
    markdownSource.indexOf("const webWrap"),
    markdownSource.indexOf("{collapsed ?"),
  );
  assert.ok(wrapSource.indexOf("onPress={linePress(lineIndex)}") > wrapSource.indexOf("{lineIndex + 1}"));
  assert.match(markdownSource, /codeBlockExtras\?\.\(codeBlockIndex\)/);
  assert.match(timelineSource, /native\?\.metaKey \|\| native\?\.ctrlKey/);
  assert.match(timelineSource, /carrier\?\.stopPropagation\?\.\(\)/);
  assert.match(timelineSource, /codeAnchor: anchor/);
  assert.match(timelineSource, /commentsByCodeBlock\.get\(blockIndex\)/);
  assert.match(timelineSource, /Line \$\{comment\.codeAnchor\.lineIndex \+ 1\}/);
});

test("sent reviews render code-line quotes as a labelled code context instead of an italic quote", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.match(timelineSource, /const codeQuote = parseCodeReviewQuote\(entry\.quote\)/);
  assert.match(timelineSource, /Code block \$\{codeQuote\.blockNumber\}.*Line \$\{codeQuote\.lineNumber\}/s);
  assert.match(timelineSource, /codeLine\.selected \? styles\.codeSelectedRow/);
  assert.match(timelineSource, /codeLine\.lineNumber/);
  assert.match(timelineSource, /codeLine\.text\.length > 0 \? codeLine\.text : " "/);
});

test("streamed final fragments render as slices of one card", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.match(timelineSource, /getTurnFinalCardPosition/);
  assert.match(timelineSource, /getTurnFinalCardText/);
  assert.match(timelineSource, /cardBridge/);
  assert.match(timelineSource, /finalCardPosition === "start"/);
  assert.match(timelineSource, /finalCardPosition === "end"/);
  assert.match(timelineSource, /accessibilityLabel="Copy agent response"/);
  assert.match(timelineSource, /copyText\(text\)/);
  assert.match(timelineSource, /timestampLabel\(timestamp\)/);
  const shellSource = timelineSource.slice(
    timelineSource.indexOf("const FinalCardShell"),
    timelineSource.indexOf("function UserMessageCard"),
  );
  const shellOnly = shellSource.slice(
    shellSource.indexOf("const FinalCardShell"),
    shellSource.indexOf("const FinalCardControls"),
  );
  assert.doesNotMatch(shellOnly, /useState\(|useEffect\(|setTimeout\(/);
  assert.match(shellSource, /text !== null && hoverKey !== null \? \(\s*<FinalCardControls/);
  assert.match(shellSource, /finalCardHoverStore\.show\(hoverKey\)/);
  assert.match(shellSource, /finalCardHoverStore\.hide\(hoverKey\)/);
  assert.match(
    shellSource,
    /onPointerMove=\{hoverKey !== null && platform === "web"/,
    "every visual slice must publish hover, including the first paragraphs",
  );
  assert.doesNotMatch(shellSource, /onPointerMove=\{text !== null/);
  assert.match(timelineSource, /hoverKey=\{finalCardHoverKey\}/);
  assert.doesNotMatch(timelineSource, /onPointerEnter=.*setHovered\(true\)/);
  assert.doesNotMatch(timelineSource, /accessibilityLabel="Rewind agent response"/);
});

test("streaming assistant text preserves completed paragraph renderers", () => {
  const timelineSource = String(readFileSync(path.resolve("client/timeline.tsx")));
  assert.match(timelineSource, /createStableParagraphs/);
  assert.match(timelineSource, /const ReviewParagraph = memo\(/);
  assert.match(timelineSource, /paragraphStream\.current!\.update\(revealed\)/);
  assert.match(timelineSource, /paragraphs\.map\(\(paragraph, index\) => \(\s*<ReviewParagraph/);
  assert.match(timelineSource, /selectable=\{platform === "web" \? undefined : platform !== "ios"\}/);
});

test("file tabs are owned by one context and use the host's real tab close control", () => {
  const entrySource = String(readFileSync(path.resolve("client/plugin-entry.tsx")));
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
  assert.match(wideFrameMutationSource, /node\.style && node\.dataset \? node : node\.parentElement/);
  assert.ok(!wideFrameMutationSource.includes("schedule(n)"));
});
