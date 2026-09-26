"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function render(lines, width = 1024, selectedRects = null, sentence = "") {
  const nodes = new Map();
  const makeNode = tag => {
    const node = {
      tag,
      children: [],
      get childNodes() { return this.children; },
      textContent: "",
      style: {},
      className: "",
      append(...items) { this.children.push(...items); },
      replaceChildren() { this.children = []; this.textContent = ""; },
      remove() { this.removed = true; },
      addEventListener() {},
      setAttribute() {},
      attachShadow() { return shadow; }
    };
    node.classList = {
      add(name) { node.className += (node.className ? " " : "") + name; },
      remove() {},
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
  const page = { top: null, innerWidth: width, addEventListener() {}, getSelection() { return null; } };
  page.top = page;
  const document = {
    adoptedStyleSheets: [],
    getElementById() { return null; },
    createElement: makeNode,
    createTextNode(text) { return { textContent: text }; },
    body: { append() {} },
    documentElement: { addEventListener() {} },
    addEventListener() {}
  };
  const source = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");
  const hooked = source.replace(/\}\)\(\);\s*$/, "globalThis.testShow = show; globalThis.testSelect = selectWord; globalThis.testClose = close; globalThis.testInfer = inferLikelyPos; globalThis.testContext = sentenceContext;})();");
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
    return { chip: nodes.get(".selected-chip"), sourceNode, context, shadow };
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

test("mobile layout keeps every meaning visible", () => {
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
