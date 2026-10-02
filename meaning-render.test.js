"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function render(lines, width = 1024, selectedRects = null, sentence = "", deferReply = false, height = 900) {
  const nodes = new Map();
  const documentListeners = new Map();
  let reply = null;
  let requestCount = 0;
  let globalStorageListener;
  const makeNode = tag => {
    const node = {
      tag,
      children: [],
      get childNodes() { return this.children; },
      textContent: "",
      style: { setProperty(name, value) { this[name] = value; } },
      get offsetWidth() { return tag === ".sheet" ? Math.min(420, Math.max(0, page.innerWidth - 32)) : 420; },
      get offsetHeight() { return tag === ".sheet" ? Math.min(120, Number.parseFloat(this.style.maxHeight) || 120) : 120; },
      className: "",
      append(...items) { this.children.push(...items); },
      replaceChildren() { this.children = []; this.textContent = ""; },
      remove() { this.removed = true; },
      addEventListener(name, listener) { this.listeners ??= new Map(); this.listeners.set(name, listener); },
      setAttribute() {},
      attachShadow() { return shadow; }
    };
    node.classList = {
      add(name) { node.className += (node.className ? " " : "") + name; },
      remove(name) { node.className = node.className.split(/\s+/).filter(value => value !== name).join(" "); },
      contains(name) { return node.className.split(/\s+/).includes(name); }
    };
    return node;
  };
  const shadow = {
    innerHTML: "",
    insertBefore(node) { nodes.set(".selected-chip", node); },
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, makeNode(selector));
      return nodes.get(selector);
    }
  };
  const page = { top: null, innerWidth: width, innerHeight: height, addEventListener() {}, getSelection() { return null; } };
  page.top = page;
  const document = {
    adoptedStyleSheets: [],
    getElementById() { return null; },
    createElement: makeNode,
    createTextNode(text) { return { textContent: text }; },
    body: { append() {} },
    documentElement: { addEventListener() {} },
    addEventListener(name, listener) { documentListeners.set(name, listener); }
  };
  const source = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  const hooked = source.replace(/\}\)\(\);\s*$/, "globalThis.testShow = show; globalThis.testSelect = selectWord; globalThis.testClose = close; globalThis.testPosition = positionPopover; globalThis.testWordAt = wordAt;})();");
  assert.notEqual(hooked, source, "content script test hook was not attached");
  const context = vm.createContext({
    window: page,
    document,
    CSS: { highlights: new Map() },
    Node: { TEXT_NODE: 3 },
    CSSStyleSheet: class { replaceSync() {} },
    Highlight: class { constructor(range) { this.range = range; } },
    getComputedStyle() { return {
      fontFamily: "Georgia", fontSize: "24px", fontWeight: "400", fontStyle: "normal",
      fontVariant: "normal", fontStretch: "normal", fontFeatureSettings: "normal",
      fontVariationSettings: "normal", fontKerning: "auto", letterSpacing: "normal", textTransform: "none"
    }; },
    chrome: { storage: { onChanged: { addListener(fn) { globalStorageListener = fn; } } }, runtime: { lastError: null, sendMessage(_message, callback) {
      requestCount++;
      if (deferReply) { reply = callback; return; }
      callback({ ok: true, data: { headword: "reserve", us: "", uk: "", lines } });
    } } },
    clearTimeout,
    setTimeout
  });
  vm.runInContext(hooked, context);
  context.testStorageChange = globalStorageListener;
  vm.runInContext(`testShow("reserve", ${JSON.stringify(sentence)})`, context);
  if (selectedRects) {
    const sourceNode = { textContent: "hello northern world", isConnected: true, parentElement: {} };
    context.testHit = { node: sourceNode, start: 6, end: 14,
      range: { getClientRects() { return selectedRects; } } };
    vm.runInContext("testSelect(testHit)", context);
    return { chip: nodes.get(".selected-chip"), sourceNode, context, shadow, documentListeners,
      requestCount() { return requestCount; },
      reply(response) { assert.ok(reply, "lookup callback is available"); reply(response); } };
  }
  const items = nodes.get(".meanings").children;
  items.context = context;
  items.shadow = shadow;
  items.phonetic = () => nodes.get(".phonetic").textContent;
  items.meanings = () => nodes.get(".meanings").children;
  items.reply = response => { assert.ok(reply, "lookup callback is available"); reply(response); };
  return items;
}

test("component phonetics are explicitly labeled rather than shown as a whole-word IPA", () => {
  const items = render([], 1024, null, "", true);
  items.reply({ ok: true, data: { headword: "well-run", us: "", uk: "",
    componentPhones: [{ word: "well", phone: "wel" }, { word: "run", phone: "rʌn" }],
    lines: ["adj. 经营得好的"] } });
  assert.equal(items.phonetic(), "组成词音标：well /wel/ · run /rʌn/");
});

test("several attested pronunciations are visible rather than silently picking one", () => {
  const items = render([], 1024, null, "", true);
  items.reply({ ok: true, data: { headword: "learned", us: "", uk: "", ipaVariants: ["ˈɫɝnd", "ˈɫɝnɪd"],
    lines: ["adj. 博学的"] } });
  assert.equal(items.phonetic(), "/ˈɫɝnd/ · /ˈɫɝnɪd/");
});

test("capitalization alone and network failures never claim a person", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, width: 94, height: 30 }], "", true);
  selected.sourceNode.parentElement.closest = () => ({ textContent: "African Parks protects animals." });
  vm.runInContext("testShow('Parks')", selected.context);
  selected.reply({ ok: false, code: "NO_ENTRY", error: "词典暂未收录这个词" });
  assert.equal(selected.shadow.querySelector(".meanings").children[0].textContent, "词典暂未收录这个词");
  selected.sourceNode.parentElement.closest = () => ({ textContent: "CEO Peter Fearnhead approved it." });
  vm.runInContext("testShow('Fearnhead')", selected.context);
  selected.reply({ ok: false, error: "网络请求失败，请稍后重试" });
  assert.equal(selected.shadow.querySelector(".meanings").children[0].textContent, "网络请求失败，请稍后重试");
});

test("a real dictionary entry is not replaced by a person-name guess", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, width: 94, height: 30 }], "", true);
  selected.sourceNode.parentElement.closest = () => ({ textContent: "CEO Peter Fearnhead approved it." });
  vm.runInContext("testShow('Fearnhead')", selected.context);
  selected.reply({ ok: true, data: { headword: "Fearnhead", lines: ["n. A genuine dictionary result"] } });
  const group = selected.shadow.querySelector(".meanings").children[0];
  assert.equal(group.children[0].textContent, "n.");
  assert.equal(group.children[1].textContent, "A genuine dictionary result");
});

test("a dictionary name keeps the clicked capitalization and its exact Chinese translation", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, width: 94, height: 30 }], "", true);
  vm.runInContext("testShow('Vickery')", selected.context);
  selected.reply({ ok: true, data: { headword: "vickery", lines: ["n. （Vickery）人名；（英）维克里"] } });
  assert.equal(selected.shadow.querySelector(".word").textContent, "Vickery");
  const group = selected.shadow.querySelector(".meanings").children[0];
  assert.equal(group.children[0].textContent, "n.");
  assert.equal(group.children[1].textContent, "（Vickery）人名；（英）维克里");
});

test("each part of speech gets a full-width row with inline glosses", () => {
  const items = render(["v. 预订；保留", "n.  储备（量），储藏（量）\n后续解释"]);
  assert.equal(items[0].tag, "div");
  assert.equal(items[0].children[0].textContent, "v.");
  const groups = items.filter(item => item.tag === "div");
  assert.equal(groups.length, 2);
  assert.equal(groups[1].children[0].textContent, "n.");
  assert.match(groups[1].children.map(child => child.textContent || "").join(""), /储备（量），储藏（量） 后续解释/);
  assert.match(fs.readFileSync(path.join(__dirname, "content.js"), "utf8"), /\.sense-group\{display:block;width:100%/);
});

test("narrow-window card keeps every meaning visible", () => {
  const items = render(["n.  储备（量），储藏（量）；备用队员\n后续解释"], 375);
  assert.equal(items[0].children[0].textContent, "n.");
  assert.match(items[0].children.map(child => child.textContent || "").join(""), /储备（量），储藏（量）；备用队员 后续解释/);
  assert.doesNotMatch(items.map(item => item.textContent || "").join(""), /更多释义/);
});

test("ordinary text is not mislabeled as a part of speech", () => {
  const items = render(["词典暂未收录这个词"]);
  assert.equal(items.length, 1);
  assert.equal(items[0].children[0].textContent, "词典暂未收录这个词");
});

test("tabs, non-breaking spaces and CRLF do not lose the definition", () => {
  const items = render(["adj.\t有用的\r\n其他解释", "adv.\u00a0迅速地"]);
  const groups = items.filter(item => item.tag === "div");
  assert.equal(groups[0].children[0].textContent, "adj.");
  assert.match(groups[0].children.map(child => child.textContent || "").join(""), /有用的 其他解释/);
  assert.equal(groups[1].children[0].textContent, "adv.");
  assert.match(groups[1].children.map(child => child.textContent || "").join(""), /迅速地/);
});

test("sentence context never changes the dictionary's part-of-speech order", () => {
  const items = render(["n. 储备；储藏", "v. 预订；保留"], 1024, null, "They can reserve the seats.");
  const groups = items.filter(item => item.tag === "div");
  assert.equal(groups[0].children[0].textContent, "n.");
  assert.equal(groups[0].children[1].className, "meaning");
  assert.match(groups[0].children.map(child => child.textContent || "").join(""), /储备；储藏/);
  assert.equal(groups[1].children[0].textContent, "v.");
  assert.match(groups[1].children.map(child => child.textContent || "").join(""), /预订；保留/);
});

test("the panel keeps repeated meanings and separate transitive and intransitive labels", () => {
  const items = render(["n. 保留", "n. 保留", "vt. 保留", "vi. 保留"]);
  const groups = items.filter(item => item.tag === "div");
  assert.deepEqual(groups.map(group => group.children[0].textContent), ["n.", "vt.", "vi."]);
  assert.equal(groups[0].children.map(child => child.textContent || "").join(""), "n.保留；保留");
});

test("a click near the end of a long paragraph measures only the clicked word", () => {
  const selected = render([]);
  const text = "ordinary ".repeat(200) + "risk-diversified nearby";
  const node = { nodeType: 3, textContent: text };
  const start = text.indexOf("risk-diversified");
  let measured = 0;
  selected.context.document.caretPositionFromPoint = () => ({ offsetNode: node, offset: start + 5 });
  selected.context.document.createRange = () => {
    let left;
    let right;
    return {
      setStart(_node, value) { left = value; },
      setEnd(_node, value) { right = value; },
      getClientRects() {
        measured++;
        return [{ left: left * 10, right: right * 10, top: 0, bottom: 20, width: (right - left) * 10, height: 20 }];
      }
    };
  };
  const hit = selected.context.testWordAt((start + 5) * 10, 10);
  assert.equal(hit.word, "risk-diversified");
  assert.equal(hit.start, start);
  assert.equal(node.textContent, text);
  assert.ok(measured <= 2, `measured ${measured} words`);
});

test("word lookup still accepts a caret at the end of an apostrophe word", () => {
  const selected = render([]);
  const text = "Jooste’s arrived";
  const node = { nodeType: 3, textContent: text };
  selected.context.document.caretPositionFromPoint = () => ({ offsetNode: node, offset: 8 });
  selected.context.document.createRange = () => {
    let left;
    let right;
    return {
      setStart(_node, value) { left = value; },
      setEnd(_node, value) { right = value; },
      getClientRects() { return [{ left: left * 10, right: right * 10, top: 0, bottom: 20 }]; }
    };
  };
  assert.equal(selected.context.testWordAt(75, 10).word, "Jooste's");
  assert.equal(selected.context.testWordAt(85, 10), null);
});

test("an imprecise browser caret falls back to the original geometric hit test", () => {
  const selected = render([]);
  const node = { nodeType: 3, textContent: "first second" };
  selected.context.document.caretPositionFromPoint = () => ({ offsetNode: node, offset: 1 });
  selected.context.document.createRange = () => {
    let left;
    let right;
    return {
      setStart(_node, value) { left = value; },
      setEnd(_node, value) { right = value; },
      getClientRects() { return [{ left: left * 10, right: right * 10, top: 0, bottom: 20 }]; }
    };
  };
  assert.equal(selected.context.testWordAt(75, 10).word, "second");
});

test("a bold word split between inline text nodes is looked up and highlighted as one word", () => {
  const selected = render([]);
  const block = { textContent: "The collective term for a group of rhinos is a crash." };
  const nodes = ["T", "he collective term for a group of rhinos is a crash."].map(text => ({
    nodeType: 3, textContent: text, isConnected: true,
    parentElement: { closest(selector) { return selector.startsWith("p,") ? block : null; } }
  }));
  const at = node => nodes.indexOf(node);
  const starts = [0, 1];
  selected.context.document.caretPositionFromPoint = () => ({ offsetNode: nodes[0], offset: 0 });
  selected.context.document.createTreeWalker = () => ({
    currentNode: nodes[0],
    previousNode() { const node = nodes[at(this.currentNode) - 1] || null; if (node) this.currentNode = node; return node; },
    nextNode() { const node = nodes[at(this.currentNode) + 1] || null; if (node) this.currentNode = node; return node; }
  });
  selected.context.NodeFilter = { SHOW_TEXT: 4 };
  selected.context.document.createRange = () => {
    let start = 0;
    let end = 0;
    return {
      setStart(node, offset) { start = starts[at(node)] + offset; },
      setEnd(node, offset) { end = starts[at(node)] + offset; },
      selectNodeContents() { start = 0; end = block.textContent.length; },
      toString() { return block.textContent.slice(start, end); },
      getClientRects() {
        const parts = [];
        if (start < 1 && end > 0) parts.push({ left: 100, right: 110, top: 20, bottom: 50, width: 10, height: 30 });
        if (start < 3 && end > 1) parts.push({ left: 110, right: 130, top: 20, bottom: 50, width: 20, height: 30 });
        return parts;
      }
    };
  };
  const hit = selected.context.testWordAt(105, 35);
  assert.equal(hit.word, "The");
  assert.equal(hit.range.toString(), "The");
  selected.context.testSelect(hit);
  assert.equal(selected.shadow.querySelector(".selected-chip").textContent, "The");
  assert.equal(nodes.map(node => node.textContent).join(""), block.textContent);
});

test("em dashes separate words while true hyphens still form compounds", () => {
  const selected = render([]);
  const text = "diprenorphine—a “wake-up” drug";
  const node = { nodeType: 3, textContent: text };
  selected.context.document.caretPositionFromPoint = x => ({ offsetNode: node, offset: Math.floor(x / 10) });
  selected.context.document.createRange = () => {
    let left;
    let right;
    return {
      setStart(_node, value) { left = value; },
      setEnd(_node, value) { right = value; },
      getClientRects() { return [{ left: left * 10, right: right * 10, top: 0, bottom: 20 }]; }
    };
  };
  const hit = index => selected.context.testWordAt(index * 10 + 5, 10)?.word || null;
  assert.equal(hit(text.indexOf("diprenorphine") + 4), "diprenorphine");
  assert.equal(hit(text.indexOf("—")), null);
  assert.equal(hit(text.indexOf("—") + 1), "a");
  assert.equal(hit(text.indexOf("wake-up") + 3), "wake-up");
  assert.equal(node.textContent, text);
});

test("the rounded chip covers only the clicked word without rewriting article text", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, width: 94, height: 30 }]);
  assert.equal(selected.chip.textContent, "northern");
  assert.equal(selected.chip.style.left, "80px");
  assert.equal(selected.chip.style.width, "94px");
  assert.match(selected.shadow.innerHTML, /\.selected-chip\{[^}]*border-radius:4px/);
  assert.equal(selected.sourceNode.textContent, "hello northern world");
  vm.runInContext("testClose()", selected.context);
  assert.equal(selected.chip.removed, true);
});

test("the extension preserves the page cursor while clicked words retain gold", () => {
  const source = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  assert.doesNotMatch(source, /word-lookup-hover|hoverStyle|pointermove|cursor:pointer!important/);
  assert.match(source, /\.selected-chip\{[^}]*background:#80621f/);
});

test("desktop lookup stays near a top word and flips above a bottom word", () => {
  const top = render([], 1024, [{ left: 80, top: 100, right: 174, bottom: 130, width: 94, height: 30 }]);
  vm.runInContext("testPosition()", top.context);
  assert.equal(top.shadow.querySelector(".sheet").style.top, "140px");
  assert.equal(top.shadow.querySelector(".sheet").style.left, "80px");
  const bottom = render([], 1024, [{ left: 80, top: 820, right: 174, bottom: 850, width: 94, height: 30 }]);
  vm.runInContext("testPosition()", bottom.context);
  assert.equal(bottom.shadow.querySelector(".sheet").style.top, "690px");
  assert.equal(bottom.shadow.querySelector(".sheet").style.left, "80px");
});

test("desktop lookup uses nearby side space without changing source text", () => {
  const selected = render([], 1024, [{ left: 280, top: 320, right: 374, bottom: 350, width: 94, height: 30 }]);
  selected.sourceNode.parentElement.getBoundingClientRect = () => ({ left: 80, right: 400 });
  vm.runInContext("testPosition()", selected.context);
  assert.equal(selected.shadow.querySelector(".sheet").style.left, "410px");
  assert.equal(selected.sourceNode.textContent, "hello northern world");
  assert.doesNotMatch(selected.shadow.innerHTML, /backdrop|aria-modal/);
});

test("a narrow desktop window keeps the nearby card inside the viewport", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, right: 174, bottom: 130, width: 94, height: 30 }]);
  vm.runInContext("testPosition()", selected.context);
  selected.context.window.innerWidth = 375;
  vm.runInContext("testPosition()", selected.context);
  assert.equal(selected.shadow.querySelector(".sheet").style.top, "140px");
  assert.equal(selected.shadow.querySelector(".sheet").style.left, "16px");
  assert.equal(selected.shadow.querySelector(".sheet").offsetWidth, 343);
  assert.match(selected.shadow.innerHTML, /width:min\(420px,calc\(100vw - 32px\)\)/);
  assert.doesNotMatch(selected.shadow.innerHTML, /\.sheet\{[^}]*;bottom:0;|@media\(min-width:768px\)/);
});

test("a short narrow window flips the card above the clicked word", () => {
  const selected = render([], 500, [{ left: 80, top: 90, right: 174, bottom: 120, width: 94, height: 30 }], "", false, 200);
  vm.runInContext("testPosition()", selected.context);
  const sheet = selected.shadow.querySelector(".sheet");
  assert.equal(sheet.style.left, "64px");
  assert.equal(sheet.style.top, "16px");
  assert.equal(sheet.style.maxHeight, "64px");
});

test("a narrow resize abandons a side placement that no longer fits", () => {
  const selected = render([], 1024, [{ left: 280, top: 320, right: 374, bottom: 350, width: 94, height: 30 }]);
  selected.sourceNode.parentElement.getBoundingClientRect = () => ({ left: 80, right: 400 });
  vm.runInContext("testPosition()", selected.context);
  assert.equal(selected.shadow.querySelector(".sheet").style.left, "410px");
  selected.context.window.innerWidth = 500;
  vm.runInContext("testPosition()", selected.context);
  assert.equal(selected.shadow.querySelector(".sheet").style.left, "64px");
  assert.equal(selected.shadow.querySelector(".sheet").style.top, "360px");
});

test("a very short resized window keeps the card on-screen", () => {
  const selected = render([], 1024, [{ left: 80, top: 75, right: 174, bottom: 105, width: 94, height: 30 }]);
  vm.runInContext("testPosition()", selected.context);
  selected.context.window.innerWidth = 500;
  selected.context.window.innerHeight = 180;
  vm.runInContext("testPosition()", selected.context);
  const sheet = selected.shadow.querySelector(".sheet");
  assert.equal(sheet.style.top, "56px");
  assert.equal(sheet.style.maxHeight, "108px");
  assert.equal(sheet.offsetWidth, 420);
  assert.equal(selected.sourceNode.textContent, "hello northern world");
});

test("a second page click closes the lookup instead of looking up another word", () => {
  for (const width of [1024, 375]) {
    const selected = render([], width, [{ left: 80, top: 100, right: 174, bottom: 130, width: 94, height: 30 }]);
    assert.equal(selected.shadow.querySelector(".sheet").classList.contains("open"), true);
    selected.documentListeners.get("click")({ button: 0, composedPath: () => [], target: {} });
    assert.equal(selected.shadow.querySelector(".sheet").classList.contains("open"), false);
    assert.equal(selected.chip.removed, true);
    assert.equal(selected.context.CSS.highlights.size, 0);
  }
});

test("the card is populated with the complete definition before appearing", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, right: 174, bottom: 130, width: 94, height: 30 }], "", true);
  const sheet = selected.shadow.querySelector(".sheet");
  assert.equal(sheet.classList.contains("open"), false);
  assert.equal(selected.shadow.querySelector(".meanings").children.length, 0);
  selected.reply({ ok: true, data: { headword: "northern", us: "", uk: "", lines: ["adj. 北方的"] } });
  assert.equal(sheet.classList.contains("open"), true);
  assert.equal(selected.shadow.querySelector(".meanings").children[0].children[1].textContent, "北方的");
});

test("closing during a pending lookup ignores the late answer", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, right: 174, bottom: 130, width: 94, height: 30 }], "", true);
  const sheet = selected.shadow.querySelector(".sheet");
  selected.documentListeners.get("click")({ button: 0, composedPath: () => [], target: {} });
  selected.reply({ ok: true, data: { headword: "northern", us: "", uk: "", lines: ["adj. 北方的"] } });
  assert.equal(sheet.classList.contains("open"), false);
  assert.equal(selected.context.CSS.highlights.size, 0);
});

test("a repeated lookup on the same page reuses the complete answer", () => {
  const selected = render(["adj. 北方的"], 1024, [{ left: 80, top: 100, right: 174, bottom: 130, width: 94, height: 30 }]);
  assert.equal(selected.requestCount(), 1);
  vm.runInContext("testClose(); testShow('reserve')", selected.context);
  assert.equal(selected.requestCount(), 1);
  assert.equal(selected.shadow.querySelector(".sheet").classList.contains("open"), true);
  assert.equal(selected.shadow.querySelector(".meanings").children[0].children[1].textContent, "北方的");
});

test("failed lookups are retried rather than cached", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, right: 174, bottom: 130, width: 94, height: 30 }], "", true);
  selected.reply({ ok: false, error: "网络请求失败，请稍后重试" });
  vm.runInContext("testClose(); testShow('reserve')", selected.context);
  assert.equal(selected.requestCount(), 2);
  selected.reply({ ok: true, data: { headword: "reserve", us: "", uk: "", lines: ["v. 保留"] } });
  assert.equal(selected.shadow.querySelector(".meanings").children[0].children[1].textContent, "保留");
});

test("speed optimizations keep the existing animation timings", () => {
  const source = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  assert.match(source, /const pendingDelay = 400;/);
  assert.match(source, /sendMessage\(\{ type: "warmup" \}/);
  assert.match(source, /\.sheet\{position:fixed;left:0;top:0;[^}]*transition:opacity \.1s ease-in/);
  assert.match(source, /\.sheet\.open\{opacity:1;[^}]*transition:opacity \.13s ease-out/);
});


test("nonadjacent identical POS labels never reorder the dictionary's senses", () => {
  const groups = render(["n. 第一项", "v. 第二项", "n. 第三项"]);
  assert.deepEqual(groups.map(group => group.children[0].textContent), ["n.", "v.", "n."]);
  assert.deepEqual(groups.map(group => group.children[1].textContent), ["第一项", "第二项", "第三项"]);
});

test("an unlisted name never scans the article or invents a definition", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, width: 94, height: 30 }], "", true);
  selected.sourceNode.parentElement.closest = () => ({ get textContent() { throw new Error("must not scan article text"); } });
  vm.runInContext("testShow('Fearnhead')", selected.context);
  selected.reply({ ok: false, code: "NO_ENTRY", error: "词典暂未收录这个词" });
  assert.equal(selected.shadow.querySelector(".meanings").children[0].textContent, "词典暂未收录这个词");
});

test("restore clears page copies and rejects an old outstanding reply", () => {
  const selected = render([], 1024, [{ left: 80, top: 100, width: 94, height: 30 }], "", true);
  selected.reply({ ok: true, data: { lines: ["n. 旧释义"] } });
  selected.context.testStorageChange({ "library-meta:restored": { newValue: 2 } }, "local");
  assert.equal(selected.shadow.querySelector(".sheet").classList.contains("open"), false);
  vm.runInContext("testShow('reserve')", selected.context);
  assert.equal(selected.requestCount(), 2);
  selected.context.testStorageChange({ "library-meta:restored": { newValue: 3 } }, "local");
  selected.reply({ ok: true, data: { lines: ["n. 已取消的旧回调"] } });
  assert.equal(selected.shadow.querySelector(".sheet").classList.contains("open"), false);
});

test("extension reload gives an actionable error instead of leaving a stuck pending state", () => {
  const selected = render([], 1024, null, "", true);
  selected.context.chrome.runtime.sendMessage = () => { throw new Error("Extension context invalidated"); };
  vm.runInContext("testShow('reserve')", selected.context);
  assert.match(selected.meanings()[0].textContent, /刷新网页/);
});

test("audio failure is visible without silently switching to system speech", async () => {
  const selected = render(["n. 储备"]);
  let url;
  selected.context.Audio = class {
    constructor(value) { url = value; }
    play() { return Promise.reject(new Error("offline")); }
    pause() {}
  };
  selected.shadow.querySelector(".speaker").listeners.get("click")();
  await Promise.resolve();
  assert.match(url, /type=2$/);
  assert.equal(selected.shadow.querySelector(".speaker").style.color, "#ff3b30");
  vm.runInContext("testClose()", selected.context);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "content.js"), "utf8"), /speechSynthesis|SpeechSynthesisUtterance/);
});

test("clicking a definition no longer closes the card while selecting text", () => {
  const selected = render(["n. 储备"]);
  assert.equal(selected.shadow.querySelector(".sheet").listeners?.has("click") || false, false);
});
