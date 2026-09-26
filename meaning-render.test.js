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
  const hooked = source.replace(/\}\)\(\);\s*$/, "globalThis.testShow = show; globalThis.testSelect = selectWord; globalThis.testClose = close; globalThis.testPosition = positionPopover; globalThis.testInfer = inferLikelyPos; globalThis.testContext = sentenceContext;})();");
  assert.notEqual(hooked, source, "content script test hook was not attached");
  const context = vm.createContext({
    window: page,
    document,
    CSS: { highlights: new Map() },
    CSSStyleSheet: class { replaceSync() {} },
    Highlight: class { constructor(range) { this.range = range; } },
    getComputedStyle() { return {
      fontFamily: "Georgia", fontSize: "24px", fontWeight: "400", fontStyle: "normal",
      fontVariant: "normal", fontStretch: "normal", fontFeatureSettings: "normal",
      fontVariationSettings: "normal", fontKerning: "auto", letterSpacing: "normal", textTransform: "none"
    }; },
    chrome: { runtime: { lastError: null, sendMessage(_message, callback) {
      requestCount++;
      if (deferReply) { reply = callback; return; }
      callback({ ok: true, data: { headword: "reserve", us: "", uk: "", lines } });
    } } },
    clearTimeout,
    setTimeout
  });
  vm.runInContext(hooked, context);
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
  return items;
}

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

test("the likely part of speech moves first without claiming a specific gloss", () => {
  const items = render(["n. 储备；储藏", "v. 预订；保留"], 1024, null, "They can reserve the seats.");
  const groups = items.filter(item => item.tag === "div");
  assert.equal(groups[0].children[0].textContent, "v.");
  assert.equal(groups[0].children[1].className, "meaning");
  assert.match(groups[0].children.map(child => child.textContent || "").join(""), /预订；保留/);
  assert.equal(groups[1].children[0].textContent, "n.");
  assert.match(groups[1].children.map(child => child.textContent || "").join(""), /储备；储藏/);
});

test("the panel keeps repeated meanings and separate transitive and intransitive labels", () => {
  const items = render(["n. 保留", "n. 保留", "vt. 保留", "vi. 保留"]);
  const groups = items.filter(item => item.tag === "div");
  assert.deepEqual(groups.map(group => group.children[0].textContent), ["n.", "vt.", "vi."]);
  assert.equal(groups[0].children.map(child => child.textContent || "").join(""), "n.保留；保留");
});

test("clear preposition and verb contexts can reorder the matching part of speech", () => {
  const selected = render([]);
  assert.equal(selected.context.testInfer("The ranch lies outside Klerksdorp in South Africa.", "outside", ["n", "prep", "adv"]), "prep");
  assert.equal(selected.context.testInfer("They can reserve the seats.", "reserve", ["n", "v"]), "v");
  assert.equal(selected.context.testInfer("The reserve was protected.", "reserve", ["n", "v"]), "n");
  assert.equal(selected.context.testInfer("The light is bright.", "light", ["n", "adj"]), "n");
  assert.equal(selected.context.testInfer("Reserve outside.", "reserve", ["n", "v"]), "");
});

test("sentence context is read from the clicked text node without rewriting it", () => {
  const selected = render([]);
  const text = "Earlier text. The ranch lies outside Klerksdorp. Later text.";
  const start = text.indexOf("outside");
  const sourceNode = { textContent: text };
  const contextText = selected.context.testContext({ node: sourceNode, start, end: start + "outside".length });
  assert.equal(contextText, "The ranch lies outside Klerksdorp");
  assert.equal(sourceNode.textContent, text);
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

test("the card waits for the complete definition before appearing", () => {
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
  assert.match(source, /\.sheet\{position:fixed;left:0;top:0;[^}]*transition:opacity \.13s ease-in/);
  assert.match(source, /\.sheet\.open\{opacity:1;[^}]*transition:opacity \.18s ease-out/);
});
