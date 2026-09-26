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
      .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.3);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .18s,visibility 0s .28s}
      .backdrop.open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .18s}
      .sheet{position:fixed;left:50%;bottom:0;width:min(100%,640px);max-height:65vh;max-height:65svh;overflow:auto;padding:20px 20px calc(32px + env(safe-area-inset-bottom));background:#f8f7f3;color:#242424;border-radius:20px 20px 0 0;box-shadow:0 -4px 24px rgba(0,0,0,.12);font-family:Arial,"Microsoft YaHei",sans-serif;pointer-events:auto;transform:translate3d(-50%,100%,0);visibility:hidden;transition:transform .28s cubic-bezier(.22,.72,.24,1),visibility 0s .28s}
      .sheet.open{transform:translate3d(-50%,0,0);visibility:visible;transition:transform .28s cubic-bezier(.22,.72,.24,1)}
      .head{display:flex;align-items:center;gap:5px;min-height:32px;margin-bottom:10px}
      .word{font-size:22px;line-height:1.3;font-weight:700;color:#80621f;overflow-wrap:anywhere}
      .phonetic{font-size:13px;color:#6b7280;white-space:nowrap}
      button{appearance:none;border:0;background:transparent;cursor:pointer}
      .speaker{display:grid;place-items:center;flex:0 0 26px;width:26px;height:26px;margin-left:6px;border-radius:50%;background:#efe7d4;color:#80621f}
      .speaker svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
      .close{margin-left:auto;flex:0 0 28px;width:28px;height:28px;color:#242424;font-size:24px;line-height:1}
      .meanings{width:100%;margin-bottom:0;color:#3a3a3c;font:15px/1.7 Arial,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}
      .sense-group{display:block;width:100%;margin:0 0 6px}
      .sense-group:last-child{margin-bottom:0}
      .sense-heading{display:inline-block;vertical-align:baseline;margin:0 7px 0 0;padding:0 5px;border-radius:4px;background:#efe7d4;color:#80621f;font-size:12px;line-height:1.55;font-weight:700;letter-spacing:0}
      .meaning{display:inline;font-size:15px;line-height:1.7}
      .loading,.error{margin:0;color:#6b7280;font-size:15px}
      @media(min-width:768px){.sheet{bottom:24px;border-radius:20px;padding-bottom:32px}}
      @media(max-width:480px){.head{flex-wrap:wrap}}
      :host([data-theme="dark"]) .selected-chip{background:#c39b45;color:#1b1b1b}
      :host([data-theme="dark"]) .sheet{background:#20201e;color:#f1efe8;box-shadow:0 -4px 24px rgba(0,0,0,.35)}
      :host([data-theme="dark"]) .word,:host([data-theme="dark"]) .speaker{color:#dfbe73}
      :host([data-theme="dark"]) .speaker{background:#343125}
      :host([data-theme="dark"]) .phonetic,:host([data-theme="dark"]) .loading,:host([data-theme="dark"]) .error{color:#aaa69d}
      :host([data-theme="dark"]) .close{color:#f1efe8}
      :host([data-theme="dark"]) .meanings{color:#e4e0d8}
      :host([data-theme="dark"]) .sense-heading{background:#343125;color:#dfbe73}
      @media(prefers-reduced-motion:reduce){.sheet,.backdrop{transition:none}}
    </style>
    <div class="backdrop"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-label="单词释义">
      <div class="head"><span class="word"></span><span class="phonetic"></span>
        <button class="speaker" type="button" aria-label="播放发音"><svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zM17 9a5 5 0 0 1 0 6M19.5 6.5a9 9 0 0 1 0 11"/></svg></button>
        <button class="close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="meanings"></div>
    </section>`;

  const backdrop = shadow.querySelector(".backdrop");
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
  try {
    selectedStyle = new CSSStyleSheet();
    selectedStyle.replaceSync("::highlight(word-lookup-selected){background-color:#80621f;color:#fff}");
    roundedStyle = new CSSStyleSheet();
    roundedStyle.replaceSync("::highlight(word-lookup-selected){background-color:transparent;color:transparent}");
  } catch (_) { selectedStyle = null; roundedStyle = null; }

  (document.body || document.documentElement).append(host);

  function close() {
    requestId++;
    clearSelected();
    sheet.classList.remove("open");
    backdrop.classList.remove("open");
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
    activeWord = word.toLowerCase();
    wordEl.textContent = word;
    phoneticEl.textContent = "";
    meaningsEl.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "loading";
    loading.textContent = "正在获取释义…";
    meaningsEl.append(loading);
    chrome.runtime.sendMessage({ type: "lookup", word: activeWord, surface: word }, response => {
      if (current !== requestId) return;
      meaningsEl.replaceChildren();
      if (chrome.runtime.lastError || !response || !response.ok) {
        const error = document.createElement("p");
        error.className = "error";
        error.textContent = (response && response.error) || "释义暂时无法加载";
        meaningsEl.append(error);
        open();
        return;
      }
      const data = response.data;
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
    });
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
    backdrop.classList.add("open");
    sheet.classList.add("open");
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
      const hit = Array.from(rectRange.getClientRects()).some(rect =>
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
      if (hit) return { word: match[0].replace(/’/g, "'").replace(/[‐‑‒–—]/g, "-"), range: rectRange, node, start: match.index, end: match.index + match[0].length };
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
        shadow.insertBefore(selectedChip, backdrop);
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
    if (event.button !== 0 || !eligibleTarget(event)) return;
    if (pointerDown && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 7) return;
    if (window.getSelection()?.toString().trim()) return;
    const hit = wordAt(event.clientX, event.clientY);
    if (hit) {
      syncSurfaceTheme(hit.node);
      selectWord(hit);
      show(hit.word, sentenceContext(hit));
    }
  }, true);

  backdrop.addEventListener("click", close);
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
