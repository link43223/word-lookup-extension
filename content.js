(() => {
  "use strict";

  if (window.top !== window || document.getElementById("word-lookup-extension")) return;

  const host = document.createElement("div");
  host.id = "word-lookup-extension";
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      *,*::before,*::after{box-sizing:border-box}
      .selected-chip{position:fixed;display:block;overflow:hidden;white-space:pre;pointer-events:none;background:#80621f;color:#fff;border-radius:4px;text-align:left}
      .lookup-pending{position:fixed;pointer-events:none;padding:3px 7px;border-radius:6px;background:#f8f7f3;color:#80621f;box-shadow:0 2px 10px rgba(0,0,0,.14);font:12px/1.4 Arial,"Microsoft YaHei",sans-serif;white-space:nowrap}
      .sheet{position:fixed;left:0;top:0;width:min(420px,calc(100vw - 32px));max-height:calc(100svh - 32px);overflow:auto;padding:18px 20px 20px;background:#f8f7f3;color:#242424;border-radius:16px;box-shadow:0 -4px 24px rgba(0,0,0,.12);font-family:Arial,"Microsoft YaHei",sans-serif;pointer-events:auto;opacity:0;transform:translate3d(var(--enter-x,0px),var(--enter-y,5px),0);visibility:hidden;transition:opacity .13s ease-in,transform .13s ease-in,visibility 0s .13s}
      .sheet.open{opacity:1;transform:translate3d(0,0,0);visibility:visible;transition:opacity .18s ease-out,transform .18s cubic-bezier(.2,.8,.2,1),visibility 0s}
      .head{display:flex;align-items:center;flex-wrap:wrap;gap:5px;min-height:32px;margin-bottom:10px}
      .word{font-size:22px;line-height:1.3;font-weight:700;color:#80621f;overflow-wrap:anywhere}
      .phonetic{font-size:13px;color:#6b7280;overflow-wrap:anywhere}
      button{appearance:none;border:0;background:transparent;cursor:pointer}
      .speaker{display:inline-flex;align-items:center;justify-content:center;flex:0 0 26px;width:26px;height:26px;padding:0;border-radius:50%;cursor:pointer;margin-left:6px;color:#80621f;background:#e8f0fe;transition:all .15s;vertical-align:middle}
      .speaker:hover{background:#d0e2fc}
      .speaker:active{transform:scale(.9);background:#b8d4f8}
      .close{margin-left:auto;flex:0 0 28px;width:28px;height:28px;color:#242424;font-size:24px;line-height:1}
      .meanings{width:100%;margin-bottom:0;color:#3a3a3c;font:15px/1.7 Arial,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}
      .sense-group{display:block;width:100%;margin:0 0 6px}
      .sense-group:last-child{margin-bottom:0}
      .sense-heading{display:inline-block;vertical-align:baseline;margin:0 7px 0 0;padding:0 5px;border-radius:4px;background:#efe7d4;color:#80621f;font-size:12px;line-height:1.55;font-weight:700;letter-spacing:0}
      .meaning{display:inline;font-size:15px;line-height:1.7}
      .loading,.error{margin:0;color:#6b7280;font-size:15px}
      .meanings{min-height:52px}
      :host([data-theme="dark"]) .selected-chip{background:#c39b45;color:#1b1b1b}
      :host([data-theme="dark"]) .lookup-pending{background:#20201e;color:#dfbe73}
      :host([data-theme="dark"]) .sheet{background:#20201e;color:#f1efe8;box-shadow:0 -4px 24px rgba(0,0,0,.35)}
      :host([data-theme="dark"]) .word{color:#dfbe73}
      :host([data-theme="dark"]) .phonetic,:host([data-theme="dark"]) .loading,:host([data-theme="dark"]) .error{color:#aaa69d}
      :host([data-theme="dark"]) .close{color:#f1efe8}
      :host([data-theme="dark"]) .meanings{color:#e4e0d8}
      :host([data-theme="dark"]) .sense-heading{background:#343125;color:#dfbe73}
      @media(prefers-reduced-motion:reduce){.sheet,.sheet.open{transition:none}}
    </style>
    <section class="sheet" role="dialog" aria-label="单词释义">
      <div class="head"><span class="word"></span><span class="phonetic"></span>
        <button class="speaker" type="button" aria-label="播放发音"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19 11,5"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg></button>
        <button class="close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="meanings"></div>
    </section>`;

  const sheet = shadow.querySelector(".sheet");
  const wordEl = shadow.querySelector(".word");
  const phoneticEl = shadow.querySelector(".phonetic");
  const meaningsEl = shadow.querySelector(".meanings");
  const speaker = shadow.querySelector(".speaker");
  let requestId = 0;
  let activeWord = "";
  let audio = null;
  let playbackId = 0;
  let speakerResetTimer = 0;
  let pointerDown = null;
  // Visual-only styling: no word wrappers or changes to the article DOM.
  let selectedStyle = null;
  let roundedStyle = null;
  let selectedHit = null;
  let selectedChip = null;
  let selectedFrame = 0;
  let selectedRounded = false;
  let popoverPlacement = "";
  let lookupPending = false;
  let pendingTimer = 0;
  let pendingIndicator = null;
  const recentLookups = new Map();
  const recentLookupAge = 30 * 24 * 60 * 60 * 1000;
  const recentLookupLimit = 128;
  try {
    selectedStyle = new CSSStyleSheet();
    selectedStyle.replaceSync("::highlight(word-lookup-selected){background-color:#80621f;color:#fff}");
    roundedStyle = new CSSStyleSheet();
    roundedStyle.replaceSync("::highlight(word-lookup-selected){background-color:transparent;color:transparent}");
  } catch (_) { selectedStyle = null; roundedStyle = null; }

  (document.body || document.documentElement).append(host);

  function close() {
    requestId++;
    lookupPending = false;
    clearPendingIndicator();
    clearSelected();
    popoverPlacement = "";
    sheet.classList.remove("open");
    stopPronunciation();
  }

  function setSpeakerState(state) {
    clearTimeout(speakerResetTimer);
    speaker.style.color = state === "playing" ? "#10b981" : state === "error" ? "#ff3b30" : "";
    speaker.setAttribute("aria-label", state === "playing" ? "正在播放发音" : state === "error" ? "发音播放失败" : "播放发音");
    if (state === "error") speakerResetTimer = setTimeout(() => setSpeakerState("idle"), 1500);
  }

  function stopPronunciation() {
    playbackId++;
    if (audio) { audio.pause(); audio = null; }
    setSpeakerState("idle");
  }

  function show(word, context = "") {
    requestId++;
    const current = requestId;
    lookupPending = true;
    clearPendingIndicator();
    popoverPlacement = "";
    activeWord = word.toLowerCase();
    const cacheKey = activeWord + (activeWord.endsWith("'s") ? ":" + word : "");
    wordEl.textContent = word;
    phoneticEl.textContent = "";
    meaningsEl.replaceChildren();
    const cached = recentLookups.get(cacheKey);
    if (cached) {
      recentLookups.delete(cacheKey);
      if (Date.now() - cached.at < recentLookupAge) {
        recentLookups.set(cacheKey, cached);
        showResponse({ ok: true, data: cached.data }, word, context, current);
        return;
      }
    }
    pendingTimer = setTimeout(() => {
      if (current !== requestId || !lookupPending || !selectedHit) return;
      pendingIndicator = document.createElement("span");
      pendingIndicator.className = "lookup-pending";
      pendingIndicator.textContent = "查询中…";
      shadow.insertBefore(pendingIndicator, sheet);
      positionPendingIndicator();
    }, 1000);
    chrome.runtime.sendMessage({ type: "lookup", word: activeWord, surface: word }, response => {
      showResponse(chrome.runtime.lastError ? null : response, word, context, current, cacheKey);
    });
  }

  function showResponse(response, word, context, current, cacheKey = "") {
    if (current !== requestId) return;
    lookupPending = false;
    clearPendingIndicator();
    meaningsEl.replaceChildren();
    if (!response || !response.ok) {
      const error = document.createElement("p");
      error.className = "error";
      error.textContent = (response && response.error) || "释义暂时无法加载";
      meaningsEl.append(error);
      open();
      return;
    }
    const data = response.data;
    if (cacheKey) {
      recentLookups.delete(cacheKey);
      recentLookups.set(cacheKey, { at: Date.now(), data });
      if (recentLookups.size > recentLookupLimit) recentLookups.delete(recentLookups.keys().next().value);
    }
    if (data.note) {
      const note = document.createElement("p");
      note.className = "loading";
      note.textContent = data.note;
      meaningsEl.append(note);
    }
    const headword = typeof data.headword === "string" && /^[a-z]+(?:['-][a-z]+)*$/i.test(data.headword) ? data.headword : word;
    wordEl.textContent = headword;
    const phonetic = typeof data.us === "string" && data.us ? data.us : typeof data.uk === "string" ? data.uk : "";
    phoneticEl.textContent = phonetic ? "/" + phonetic.replace(/^\/+|\/+$/g, "") + "/" : "";
    renderMeanings(data.meanings || parseMeaningLines(data.lines || []), context, activeWord);
    if (!meaningsEl.childNodes.length) meaningsEl.textContent = "暂时无法获取释义";
    open();
  }

  function clearPendingIndicator() {
    clearTimeout(pendingTimer);
    pendingTimer = 0;
    if (pendingIndicator) { pendingIndicator.remove(); pendingIndicator = null; }
  }

  function positionPendingIndicator() {
    if (!pendingIndicator || !selectedHit || !selectedHit.node.isConnected) return;
    const rect = Array.from(selectedHit.range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
    if (!rect) return;
    const width = pendingIndicator.offsetWidth || 64;
    pendingIndicator.style.left = Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))) + "px";
    pendingIndicator.style.top = Math.round(Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 28))) + "px";
  }

  function renderMeanings(entries, context, word) {
    const groups = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry.text !== "string" || !entry.text.trim()) continue;
      const pos = normalizePos(entry.pos);
      if (!groups.has(pos)) groups.set(pos, []);
      groups.get(pos).push(entry);
    }
    const likely = inferLikelyPos(context, word, Array.from(groups.keys()));
    const ordered = Array.from(groups.entries());
    if (likely) ordered.sort(([left], [right]) => left === likely ? -1 : right === likely ? 1 : 0);
    for (const [pos, items] of ordered) {
      const group = document.createElement("div");
      group.className = "sense-group";
      if (pos) {
        const heading = document.createElement("span");
        heading.className = "sense-heading";
        heading.textContent = posName(pos);
        group.append(heading);
      }
      const showItem = (entry, index) => {
        if (index > 0) group.append(document.createTextNode("；"));
        const item = document.createElement("span");
        item.className = "meaning";
        item.textContent = entry.text;
        return item;
      };
      items.forEach((entry, index) => group.append(showItem(entry, index)));
      meaningsEl.append(group);
    }
  }

  function posName(pos) {
    return ({ n: "n.", npl: "npl.", v: "v.", vt: "vt.", vi: "vi.", adj: "adj.", adv: "adv.", prep: "prep.", conj: "conj.", pron: "pron.", art: "art.", aux: "aux.", modal: "modal.", det: "det.", num: "num.", int: "int.", abbr: "abbr.", phr: "phr.", pref: "pref.", suf: "suf." })[pos] || pos;
  }

  function normalizePos(value) {
    return typeof value === "string" ? value.toLowerCase() : "";
  }

  function parseMeaningLines(lines) {
    const result = [];
    const marker = /(^|[\s;；])(n|npl|v|vt|vi|adj|adv|prep|conj|pron|art|aux|modal|det|num|int|abbr|phr|pref|suf)\.\s*/gi;
    for (const raw of lines) {
      if (typeof raw !== "string") continue;
      const line = raw.replace(/\s+/g, " ").trim();
      const found = Array.from(line.matchAll(marker));
      if (!found.length) {
        if (line) result.push({ pos: "", text: line });
        continue;
      }
      found.forEach((match, index) => {
        const start = match.index + match[0].length;
        const end = index + 1 < found.length ? found[index + 1].index : line.length;
        const text = line.slice(start, end).replace(/^[\s;；]+|[\s;；]+$/g, "");
        if (text) result.push({ pos: normalizePos(match[2]), text });
      });
    }
    return result;
  }

  function inferLikelyPos(context, word, available) {
    if (!context || !available.length) return "";
    const tokens = Array.from(context.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g), match => ({ text: match[0], lower: match[0].toLowerCase() }));
    const target = tokens.findIndex(token => token.lower.replace(/[’]/g, "'") === word.toLowerCase());
    if (target < 0) return "";
    const before = tokens[target - 1]?.lower || "";
    const after = tokens[target + 1]?.text || "";
    const afterLower = after.toLowerCase();
    const has = pos => available.includes(pos);
    const auxiliaries = new Set(["to", "can", "could", "may", "might", "must", "shall", "should", "will", "would", "do", "does", "did"]);
    const pronouns = new Set(["i", "you", "we", "they", "he", "she", "it"]);
    const determiners = new Set(["a", "an", "the", "this", "that", "these", "those", "my", "your", "his", "her", "its", "our", "their"]);
    const prepositions = new Set(["about", "above", "across", "after", "against", "along", "among", "around", "at", "before", "behind", "below", "beneath", "beside", "between", "beyond", "by", "despite", "down", "during", "for", "from", "in", "inside", "into", "near", "of", "off", "on", "onto", "out", "outside", "over", "past", "through", "throughout", "to", "toward", "under", "underneath", "until", "upon", "with", "within", "without"]);
    if (has("prep") && prepositions.has(word.toLowerCase()) && (determiners.has(afterLower) || pronouns.has(afterLower) || (after && /^[A-Z]/.test(after) && target > 0))) return "prep";
    if (has("v") && (auxiliaries.has(before) || pronouns.has(before))) return "v";
    const copulas = new Set(["am", "is", "are", "was", "were", "be", "been", "being", "seem", "seems", "seemed", "remain", "remains", "remained"]);
    if (has("n") && determiners.has(before) && (!after || copulas.has(afterLower))) return "n";
    if (has("adj") && target + 2 < tokens.length && (determiners.has(before) || pronouns.has(before)) && !copulas.has(afterLower)) return "adj";
    return "";
  }

  function sentenceContext(hit) {
    const text = hit.node.textContent || "";
    const lowerBound = Math.max(0, hit.start - 240);
    const upperBound = Math.min(text.length, hit.end + 240);
    const sample = text.slice(lowerBound, upperBound);
    const targetStart = hit.start - lowerBound;
    const targetEnd = hit.end - lowerBound;
    const left = Math.max(sample.lastIndexOf(".", targetStart), sample.lastIndexOf("?", targetStart), sample.lastIndexOf("!", targetStart), sample.lastIndexOf(";", targetStart)) + 1;
    const endings = [sample.indexOf(".", targetEnd), sample.indexOf("?", targetEnd), sample.indexOf("!", targetEnd), sample.indexOf(";", targetEnd)].filter(index => index >= 0);
    const right = endings.length ? Math.min(...endings) : sample.length;
    return sample.slice(left, right).trim();
  }

  function open() {
    if (positionPopover() === false) return;
    sheet.classList.add("open");
  }

  function positionPopover() {
    if (!selectedHit || !selectedHit.node.isConnected) return;
    const rects = Array.from(selectedHit.range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
    const anchor = rects[selectedHit.anchorIndex || 0] || rects[0];
    if (!anchor) return;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (anchor.bottom < 0 || anchor.top > viewportHeight || anchor.right < 0 || anchor.left > viewportWidth) {
      close();
      return false;
    }
    const margin = 16;
    const gap = 10;
    const width = Math.min(sheet.offsetWidth || 420, Math.max(0, viewportWidth - 2 * margin));
    const block = selectedHit.node.parentElement?.closest?.("p,li,blockquote,h1,h2,h3") || selectedHit.node.parentElement;
    const blockRect = block?.getBoundingClientRect?.();
    const sideRight = blockRect ? blockRect.right + gap : viewportWidth;
    const sideLeft = blockRect ? blockRect.left - width - gap : -width;
    const rightIsNear = sideRight - anchor.right <= 220;
    const leftIsNear = anchor.left - (sideLeft + width) <= 220;
    const preferredHeight = Math.min(viewportHeight * .6, viewportHeight - 2 * margin);
    const sideCanStayNear = anchor.top <= viewportHeight - preferredHeight - margin + 80;
    const hasRight = sideCanStayNear && sideRight + width <= viewportWidth - margin && rightIsNear;
    const hasLeft = sideCanStayNear && sideLeft >= margin && leftIsNear;
    const belowSpace = viewportHeight - margin - anchor.bottom - gap;
    const aboveSpace = anchor.top - gap - margin;
    const tooTightForSide = Math.max(belowSpace, aboveSpace) < 64;
    if ((popoverPlacement === "right" && !hasRight) || (popoverPlacement === "left" && !hasLeft)) popoverPlacement = "";
    if ((popoverPlacement === "overlay" && !tooTightForSide) ||
        (tooTightForSide && (popoverPlacement === "below" || popoverPlacement === "above"))) popoverPlacement = "";
    if (!popoverPlacement || ((popoverPlacement === "below" && belowSpace < 96 && aboveSpace > belowSpace) ||
        (popoverPlacement === "above" && aboveSpace < 96 && belowSpace > aboveSpace))) {
      popoverPlacement = hasRight ? "right" : hasLeft ? "left" : tooTightForSide ? "overlay" : belowSpace >= aboveSpace ? "below" : "above";
    }
    const side = popoverPlacement === "right" || popoverPlacement === "left";
    const availableHeight = side ? preferredHeight : popoverPlacement === "overlay" ? viewportHeight - 2 * margin :
      Math.max(0, popoverPlacement === "below" ? belowSpace : aboveSpace);
    const maxHeight = Math.max(0, Math.min(preferredHeight, availableHeight));
    sheet.style.maxHeight = maxHeight + "px";
    const height = sheet.offsetHeight;
    const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
    const x = popoverPlacement === "right" ? sideRight : popoverPlacement === "left" ? sideLeft :
      clamp(anchor.left, margin, viewportWidth - width - margin);
    const y = popoverPlacement === "below" ? anchor.bottom + gap : popoverPlacement === "above" ? anchor.top - gap - height :
      clamp(anchor.top - 10, margin, viewportHeight - maxHeight - margin);
    sheet.style.left = Math.round(x) + "px";
    sheet.style.top = Math.round(y) + "px";
    sheet.style.setProperty("--enter-x", popoverPlacement === "right" ? "-5px" : popoverPlacement === "left" ? "5px" : "0px");
    sheet.style.setProperty("--enter-y", popoverPlacement === "above" ? "5px" : popoverPlacement === "below" ? "-5px" : "0px");
  }

  function wordAt(x, y) {
    const caret = document.caretPositionFromPoint ? document.caretPositionFromPoint(x, y) : null;
    const range = !caret && document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    const node = caret ? caret.offsetNode : range && range.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent) return null;
    const text = node.textContent;
    const matches = text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*(?:[-‐‑‒–—][A-Za-z]+(?:['’][A-Za-z]+)*)*/g);
    for (const match of matches) {
      const rectRange = document.createRange();
      rectRange.setStart(node, match.index);
      rectRange.setEnd(node, match.index + match[0].length);
      const anchorIndex = Array.from(rectRange.getClientRects()).findIndex(rect =>
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
      if (anchorIndex >= 0) return { word: match[0].replace(/’/g, "'").replace(/[‐‑‒–—]/g, "-"), range: rectRange, node, start: match.index, end: match.index + match[0].length, anchorIndex };
    }
    return null;
  }

  function clearSelected() {
    selectedHit = null;
    if (selectedFrame) cancelAnimationFrame(selectedFrame);
    selectedFrame = 0;
    if (selectedChip) { selectedChip.remove(); selectedChip = null; }
    selectedRounded = false;
    if (CSS.highlights) CSS.highlights.delete("word-lookup-selected");
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== selectedStyle && sheet !== roundedStyle);
  }

  function selectWord(hit) {
    clearSelected();
    selectedHit = hit;
    if (CSS.highlights && typeof Highlight !== "undefined") {
      CSS.highlights.set("word-lookup-selected", new Highlight(hit.range));
    }
    paintSelected();
  }

  function pageUsesDarkSurface(node) {
    const ancestors = [];
    for (let element = node && node.parentElement; element; element = element.parentElement) {
      ancestors.push(element);
      if (element === document.documentElement) break;
    }
    let color = [255, 255, 255];
    for (const element of ancestors.reverse()) {
      const match = getComputedStyle(element).backgroundColor.match(/rgba?\(([^)]+)\)/i);
      if (!match) continue;
      const values = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (values.length < 3 || values.slice(0, 3).some(value => !Number.isFinite(value))) continue;
      const alpha = values.length > 3 && Number.isFinite(values[3]) ? values[3] : 1;
      color = color.map((channel, index) => values[index] * alpha + channel * (1 - alpha));
    }
    const linear = color.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 < 0.38;
  }

  function syncSurfaceTheme(node) {
    const dark = pageUsesDarkSurface(node);
    host.dataset.theme = dark ? "dark" : "light";
    if (selectedStyle) {
      selectedStyle.replaceSync(dark
        ? "::highlight(word-lookup-selected){background-color:#c39b45;color:#1b1b1b}"
        : "::highlight(word-lookup-selected){background-color:#80621f;color:#fff}");
    }
  }

  function paintSelected() {
    if (!selectedHit) return;
    const hit = selectedHit;
    const rects = Array.from(hit.range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
    const original = hit.node.textContent.slice(hit.start, hit.end);
    const canRound = rects.length === 1 && original && hit.node.parentElement && hit.node.isConnected;
    if (canRound) {
      const rect = rects[0];
      const font = getComputedStyle(hit.node.parentElement);
      if (!selectedChip) {
        selectedChip = document.createElement("span");
        selectedChip.className = "selected-chip";
        selectedChip.setAttribute("aria-hidden", "true");
        shadow.insertBefore(selectedChip, sheet);
      }
      selectedChip.textContent = original;
      Object.assign(selectedChip.style, {
        left: rect.left + "px", top: rect.top + "px",
        width: rect.width + "px", height: rect.height + "px",
        fontFamily: font.fontFamily, fontSize: font.fontSize,
        fontWeight: font.fontWeight, fontStyle: font.fontStyle,
        fontVariant: font.fontVariant, fontStretch: font.fontStretch,
        fontFeatureSettings: font.fontFeatureSettings,
        fontVariationSettings: font.fontVariationSettings,
        fontKerning: font.fontKerning, letterSpacing: font.letterSpacing,
        textTransform: font.textTransform, lineHeight: rect.height + "px"
      });
    } else if (selectedChip) {
      selectedChip.remove();
      selectedChip = null;
    }
    const rounded = Boolean(canRound && roundedStyle && CSS.highlights && typeof Highlight !== "undefined");
    if (rounded !== selectedRounded) {
      selectedRounded = rounded;
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== selectedStyle && sheet !== roundedStyle);
      const nextStyle = rounded ? roundedStyle : selectedStyle;
      if (nextStyle && CSS.highlights) document.adoptedStyleSheets = [...document.adoptedStyleSheets, nextStyle];
    }
  }

  function scheduleSelectedPaint() {
    if (!selectedHit || selectedFrame) return;
    selectedFrame = requestAnimationFrame(() => {
      selectedFrame = 0;
      paintSelected();
      positionPendingIndicator();
      if (sheet.classList.contains("open")) positionPopover();
    });
  }

  function eligibleTarget(event) {
    if (event.composedPath().includes(host)) return null;
    const target = event.target instanceof Element ? event.target : event.target.parentElement;
    if (!target || target.closest("a,button,input,textarea,select,[contenteditable],[role=button],[role=link],code,pre")) return null;
    return target;
  }

  document.addEventListener("scroll", scheduleSelectedPaint, true);
  window.addEventListener("resize", scheduleSelectedPaint);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleSelectedPaint);
    window.visualViewport.addEventListener("scroll", scheduleSelectedPaint);
  }

  document.addEventListener("pointerdown", event => {
    pointerDown = { x: event.clientX, y: event.clientY };
  }, true);

  document.addEventListener("click", event => {
    if (event.button !== 0 || event.composedPath().includes(host)) return;
    if (sheet.classList.contains("open") || lookupPending) { close(); return; }
    if (!eligibleTarget(event)) return;
    if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 7) return;
    if (window.getSelection()?.toString().trim()) return;
    const hit = wordAt(event.clientX, event.clientY);
    if (hit) {
      syncSurfaceTheme(hit.node);
      selectWord(hit);
      show(hit.word, sentenceContext(hit));
    }
  }, true);

  sheet.addEventListener("click", event => {
    if (!event.target.closest("button")) close();
  });
  shadow.querySelector(".close").addEventListener("click", close);
  document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  speaker.addEventListener("click", () => {
    if (!activeWord) return;
    stopPronunciation();
    const current = playbackId;
    setSpeakerState("playing");
    let fallbackStarted = false;
    const fallback = () => {
      if (current !== playbackId || fallbackStarted) return;
      fallbackStarted = true;
      if (!("speechSynthesis" in window)) { setSpeakerState("error"); return; }
      try {
        const utterance = new SpeechSynthesisUtterance(activeWord);
        utterance.lang = "en-US";
        utterance.onend = () => { if (current === playbackId) setSpeakerState("idle"); };
        utterance.onerror = () => { if (current === playbackId) setSpeakerState("error"); };
        speechSynthesis.speak(utterance);
      } catch (_) { setSpeakerState("error"); }
    };
    audio = new Audio("https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(activeWord) + "&type=0");
    audio.onended = () => { if (current === playbackId) setSpeakerState("idle"); };
    audio.onerror = fallback;
    audio.play().catch(fallback);
  });
})();
