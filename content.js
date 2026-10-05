"use strict";

/* 出す物はすべて Shadow DOM の中で作る。ページ側の リセットCSS や !important に
   崩されず、こちらの見た目もページに漏れないため。差し込むだけの軽い作りに
   して、読んでいるページの邪魔をしない */

const HOST_ID = "engoloyd-select-to-ja";

/* 長い範囲を選ぶと、待ち時間も料金も跳ね上がる。段落いくつか分は通したいので
   少し余裕を持たせた上限 */
const MAX_CHARS = 1200;

/* しっぽの先が吹き出しの左端からどれだけ内側にあるか（CSSの --tail-x の既定と
   揃えてある） */
const TAIL_INSET = 14;

/* 待つ間は設定から。0（待たない）を選べるので、素直に || で既定へ落とすと
   0 が消える。数かどうかだけ見る */
function waitMs() {
  const value = Number(settings.hoverDelay);
  return Number.isFinite(value) && value >= 0 ? value : SETTINGS_DEFAULTS.hoverDelay;
}

const BUBBLE_CSS = `
/* 漫画のセリフのように、元の文へ向かって尖らせる。角は少しだけ丸めて、
   影や動きは付けない。色は設定の明暗と色味に従う */
.bubble{
  --box:#D6DAF0; --line:#B7C5D9; --ink:#000000; --soft:#707070;
  --link:#34345C; --link-hover:#DD0000; --danger:#AF0A0F;
  position:fixed; top:0; left:0;
  box-sizing:border-box;
  width:max-content; min-width:110px;
  padding:5px 18px 6px 8px;
  border:var(--bw,1px) solid var(--line); border-radius:var(--radius,7px);
  /* しっぽの二枚重ねのずらし幅。枠が太いほど、枠に見える部分も太くする */
  --tail-gap:calc(var(--bw,1px) * 2);
  background:var(--box); color:var(--ink);
  font:13px/1.5 arial,helvetica,"Hiragino Kaku Gothic ProN","Yu Gothic","MS PGothic",sans-serif;
  font-size:var(--fs,13px);
  text-align:left;
  pointer-events:auto;
}
.bubble[data-accent="orange"]{--box:#F0E0D6; --line:#D9BFB7; --link:#800000;}
.bubble[data-accent="green"]{--box:#D9EBDD; --line:#B3CDBA; --link:#17603A;}
.bubble[data-accent="gray"]{--box:#E4E4E4; --line:#BDBDBD; --link:#3A3A3A;}
@media (prefers-color-scheme: dark){
  .bubble:not([data-theme="light"]){--box:#282A2E; --line:#3F4247; --ink:#C5C8C6; --soft:#969896; --link:#81A2BE; --link-hover:#5F89AC; --danger:#CC6666;}
  .bubble:not([data-theme="light"])[data-accent="orange"]{--link:#DE935F;}
  .bubble:not([data-theme="light"])[data-accent="green"]{--link:#B5BD68;}
  .bubble:not([data-theme="light"])[data-accent="gray"]{--link:#C5C8C6;}
}
.bubble[data-theme="dark"]{--box:#282A2E; --line:#3F4247; --ink:#C5C8C6; --soft:#969896; --link:#81A2BE; --link-hover:#5F89AC; --danger:#CC6666;}
.bubble[data-theme="dark"][data-accent="orange"]{--link:#DE935F;}
.bubble[data-theme="dark"][data-accent="green"]{--link:#B5BD68;}
.bubble[data-theme="dark"][data-accent="gray"]{--link:#C5C8C6;}
.bubble[hidden]{display:none;}

/* しっぽ。枠の色と塗りの色で二枚重ね、下の一枚を1pxずらして枠線に見せる */
.bubble::before,.bubble::after{
  content:""; position:absolute; width:13px; height:10px;
  clip-path:polygon(0 0, 100% 100%, 0 100%);
}
.bubble::before{top:-10px; left:var(--tail-x,14px); background:var(--line);}
.bubble::after{top:calc(-10px + var(--tail-gap)); left:calc(var(--tail-x,14px) + var(--tail-gap)); background:var(--box);}
/* 上に出したときは、下へ向けて尖らせる */
.bubble.up::before,.bubble.up::after{clip-path:polygon(0 0, 100% 0, 0 100%);}
.bubble.up::before{top:auto; bottom:-10px;}
.bubble.up::after{top:auto; bottom:calc(-10px + var(--tail-gap));}

.x{
  position:absolute; top:2px; right:3px;
  padding:0; border:0; background:none;
  color:var(--soft); font:inherit; font-size:calc(var(--fs,13px) - 2px); line-height:1; cursor:pointer;
}
.x:hover{color:var(--link-hover);}
.body{
  font-size:var(--fs,13px); line-height:1.55;
  white-space:pre-wrap; word-break:break-word;
  max-height:40vh; overflow:auto;
  user-select:text; -moz-user-select:text;
}
.body.err{color:var(--danger);}
.body.wait{color:var(--soft);}
.foot{display:flex; flex-wrap:wrap; align-items:baseline; gap:6px; margin-top:3px;}
.foot[hidden]{display:none;}
/* 釦らしくせず、掲示板の [返信] のような括弧付きの字にする */
.act{
  flex:none; padding:0; border:0; background:none;
  color:var(--link); font:inherit; font-size:calc(var(--fs,13px) - 2px); cursor:pointer;
}
.act::before{content:"[";}
.act::after{content:"]";}
.act:hover{color:var(--link-hover);}
.act[hidden]{display:none;}
.note{margin-left:auto; font-size:calc(var(--fs,13px) - 3px); color:var(--soft); white-space:nowrap;}
`;

/* innerHTML は使わない。差し込むのは決め打ちの文字列だけとはいえ、拡張機能では
   まず疑われる書き方なので、要素を組み立てて渡す */
function make(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "role" || key.startsWith("aria-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

function buildBubble() {
  const parts = {
    x: make("button", { className: "x", type: "button", title: "閉じる", textContent: "×", "aria-label": "閉じる" }),
    body: make("div", { className: "body" }),
    ask: make("button", { className: "act ask", type: "button", textContent: "訳す", hidden: true }),
    engoloyd: make("button", {
      className: "act engoloyd", type: "button", textContent: "EnGoloydで開く",
      title: "EnGoloyd で接辞に分解して覚える", hidden: true,
    }),
    settings: make("button", { className: "act settings", type: "button", textContent: "設定を開く", hidden: true }),
    note: make("span", { className: "note" }),
  };
  parts.foot = make("div", { className: "foot" }, parts.ask, parts.engoloyd, parts.settings, parts.note);
  parts.bubble = make(
    "div",
    { className: "bubble", role: "status", "aria-live": "polite", hidden: true },
    parts.x,
    parts.body,
    parts.foot
  );
  return parts;
}

let settings = { ...SETTINGS_DEFAULTS };
let host = null;
let ui = null;
/* 吹き出しを貼り付けている相手。座標ではなく「範囲」を覚えておくと、
   ページをスクロールしても文に付いて回れる */
let anchor = null;
let shownText = "";
/* 選んだのが英単語一語のときだけ、その語。EnGoloyd へ渡せる形に整えてある */
let shownWord = "";
let translation = "";
/* 選び直した後に古い応答が返ってきて、新しい吹き出しを上書きするのを防ぐ */
let seq = 0;
/* 「設定を開く」を出すかどうか。鍵が無い・弾かれた類の失敗だけに出す */
let showSettingsFlag = false;
let placeQueued = false;
/* いま出ている吹き出しが、選んで出した物か、カーソルを合わせて出た物か。
   合わせて出た物だけ、離れたときに引っ込める */
let hoverSource = false;
let hoverTimer = null;
let hoverLeaveTimer = null;
let hoverPoint = null;

loadSettings().then((saved) => {
  settings = saved;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
  /* 札を切ったのに出たままなのは気味が悪い。出ている吹き出しが、切られた方の
     ものだったときだけ引っ込める */
  if (!settings.enabled && !hoverSource) hide();
  if (!settings.hover && hoverSource) hide();
  /* 見た目を変えたら、出ている吹き出しもその場で合わせる */
  applyBubbleLook();
});

/* ------------------------------------------------------------------ *
 * 影の中の組み立て
 * ------------------------------------------------------------------ */
function ensureUI() {
  if (ui && host && host.isConnected) return ui;
  if (ui && host) {
    /* 画面を作り替える類のページでは body ごと差し替えられて消える */
    (document.body || document.documentElement).appendChild(host);
    return ui;
  }

  host = document.createElement("div");
  host.id = HOST_ID;
  /* 影の中は守られるが、host そのものはページのCSSに晒される。位置と重なり順
     だけは後から勝てないように !important で押さえる。大きさを持たせないので
     ページの見た目には触らない */
  const fixed = {
    position: "fixed", top: "0", left: "0", width: "0", height: "0",
    margin: "0", padding: "0", border: "0",
    "z-index": "2147483647", "pointer-events": "none", "color-scheme": "light dark",
  };
  for (const [prop, value] of Object.entries(fixed)) host.style.setProperty(prop, value, "important");

  /* closed にしておくと、ページ側のスクリプトから中を触られない */
  const root = host.attachShadow({ mode: "closed" });
  ui = buildBubble();
  root.append(make("style", { textContent: BUBBLE_CSS }), ui.bubble);
  (document.body || document.documentElement).appendChild(host);

  const bubble = ui.bubble;

  /* 吹き出しの上での操作はページに流さない。押した拍子にページ側のメニューが
     閉じたり、リンクが開いたりするのを避ける */
  for (const type of ["mousedown", "mouseup", "click", "dblclick"]) {
    bubble.addEventListener(type, (e) => e.stopPropagation());
  }

  ui.x.addEventListener("click", hide);
  ui.ask.addEventListener("click", () => startTranslate(shownText));
  ui.settings.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "open-options" });
    hide();
  });
  ui.engoloyd.addEventListener("click", () => {
    const word = shownWord;
    hide();
    browser.runtime.sendMessage({ type: "open-engoloyd", word });
  });

  return ui;
}

/* ------------------------------------------------------------------ *
 * 選んだ文を読む
 * ------------------------------------------------------------------ */
function readSelection(target) {
  /* input / textarea の中の選択は window.getSelection() には出てこない。
     value を直に読む。文字単位の座標は取れないので、位置は入力欄そのもので
     代用する */
  const field = target && target.closest ? target.closest("input, textarea") : null;
  if (field && typeof field.selectionStart === "number" && field.selectionStart !== field.selectionEnd) {
    const text = String(field.value || "").slice(field.selectionStart, field.selectionEnd);
    return { text, rectOf: () => field.getBoundingClientRect(), pointOf: () => aimPoint(field.getBoundingClientRect()) };
  }

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const text = textOfRange(range);
  if (!text.trim()) return null;
  return { text, rectOf: () => range.getBoundingClientRect(), pointOf: () => rangeAim(range) };
}

/* 選んだ範囲の字を取り出す。PDFビューア（pdf.js）は行ごとに別の箱へ字を置き、
   箱と箱の間に空白が無い。そのまま繋ぐと行の終わりと次の行の頭がくっついて
   「walkedhome」になるので、行が変わったところには空白を入れる。行末で語が
   切られていれば（reserva- / tion）、ハイフンを落として繋ぐ */
function textOfRange(range) {
  /* 一つの箱の中だけで閉じている選択は、そのまま読めばよい */
  if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE) return range.toString();

  const pieces = [];
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const piece = range.cloneRange();
    piece.setStart(node, node === range.startContainer ? range.startOffset : 0);
    piece.setEnd(node, node === range.endContainer ? range.endOffset : (node.nodeValue || "").length);
    const text = piece.toString();
    if (!text) continue;
    const rect = piece.getBoundingClientRect();
    /* 見えていない字（隠された箱の中など）は選んだうちに入らない */
    if (!rect.width && !rect.height) continue;
    pieces.push({ text, top: rect.top });
  }
  if (!pieces.length) return range.toString();

  let out = "";
  let prevTop = null;
  for (const piece of pieces) {
    if (out && prevTop !== null && Math.abs(piece.top - prevTop) > 1) {
      if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(piece.text)) out = out.slice(0, -1);
      else if (!/\s$/.test(out) && !/^\s/.test(piece.text)) out += " ";
    }
    out += piece.text;
    prevTop = piece.top;
  }
  return out;
}

/* しっぽが指す先は、語や選んだ範囲の「真ん中」。何行にもまたがるときは、
   吹き出しを置く側＝最後の行の真ん中を指す */
function rangeAim(range) {
  const rects = [...range.getClientRects()].filter((rect) => rect.width || rect.height);
  if (!rects.length) return aimPoint(range.getBoundingClientRect());
  /* 1行が複数の矩形に割れることがある（途中に別のタグが挟まる場合）ので、
     最後の行に居る分をまとめてから真ん中を取る */
  const last = rects[rects.length - 1];
  const line = rects.filter((rect) => Math.abs(rect.bottom - last.bottom) < 2);
  return {
    x: (Math.min(...line.map((r) => r.left)) + Math.max(...line.map((r) => r.right))) / 2,
    top: Math.min(...line.map((r) => r.top)),
    bottom: Math.max(...line.map((r) => r.bottom)),
  };
}

function aimPoint(rect) {
  return { x: (rect.left + rect.right) / 2, top: rect.top, bottom: rect.bottom };
}

/* 英単語を一語だけ選んだときは、本体アプリで覚える方へも行けるようにする。
   「library.」のように句読点ごと選んでも拾えるよう端を削り、EnGoloyd が
   受け取れる形（英字とアポストロフィ・ハイフンだけ）に合うものだけ返す */
function wordOf(text) {
  const bare = text.replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z]+$/, "");
  return /^[A-Za-z][A-Za-z'-]*$/.test(bare) ? bare : "";
}

/* 押しただけ・記号だけ・元から日本語、で吹き出しが出ると邪魔でしかない */
function looksTranslatable(text) {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  /* 一文字の選択はほぼ誤操作。二文字から相手にする */
  if (letters < 2) return false;
  const japanese = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9d]/g) || []).length;
  if (japanese > letters) return false;
  return true;
}

/* 明暗と色味は設定に従う。影の中からはページ側の指定が見えないので、
   吹き出し自身に札を付けて中のCSSで拾う */
function applyBubbleLook() {
  if (!ui) return;
  const bubble = ui.bubble;
  bubble.dataset.theme = settings.theme || SETTINGS_DEFAULTS.theme;
  bubble.dataset.accent = settings.accent || SETTINGS_DEFAULTS.accent;
  bubble.style.setProperty("--radius", `${clampNum(settings.bubbleRadius, 0, 20, SETTINGS_DEFAULTS.bubbleRadius)}px`);
  bubble.style.setProperty("--bw", `${clampNum(settings.bubbleBorder, 0, 5, SETTINGS_DEFAULTS.bubbleBorder)}px`);
  bubble.style.setProperty("--fs", `${clampNum(settings.bubbleFont, 10, 24, SETTINGS_DEFAULTS.bubbleFont)}px`);
  /* 自分で決めた色は、明暗や色味より後に当てる。切れば元の色味に戻す */
  for (const [prop, value] of [["--box", settings.bubbleBg], ["--line", settings.bubbleLine], ["--ink", settings.bubbleInk]]) {
    if (settings.bubbleCustomColors && value) bubble.style.setProperty(prop, value);
    else bubble.style.removeProperty(prop);
  }
}

/* ------------------------------------------------------------------ *
 * 置き場所
 * ------------------------------------------------------------------ */
function currentRect() {
  if (!anchor) return null;
  let rect = null;
  try {
    rect = anchor.rectOf();
  } catch {
    /* 選択元のノードがページの書き換えで消えると範囲も無効になる */
    return null;
  }
  if (!rect || (!rect.width && !rect.height)) return null;
  const vh = window.innerHeight;
  /* 貼り付けた文が画面の外まで流れたら、吹き出しだけ残っても意味がない */
  if (rect.bottom < -40 || rect.top > vh + 40) return null;
  return rect;
}

function place() {
  const rect = currentRect();
  if (!rect) {
    hide();
    return;
  }
  const bubble = ui.bubble;
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const want = clampNum(settings.bubbleWidth, 160, 800, SETTINGS_DEFAULTS.bubbleWidth);
  bubble.style.maxWidth = `${Math.max(140, Math.min(want, vw - 16))}px`;

  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  /* しっぽの先が語の真ん中に来るように置く。先が左斜め上を向いているので、
     吹き出しはそこから右下（上に出すときは右上）へ広がる */
  let point;
  try {
    point = anchor.pointOf();
  } catch {
    point = aimPoint(rect);
  }

  /* まず語の下。入らなければ上。どちらも入らないほど狭いときは、とにかく
     画面の中に収める（訳が読めないよりはまし） */
  let top = point.bottom + 11;
  let above = false;
  if (top + bh > vh - 8) {
    const overWord = point.top - bh - 11;
    above = overWord >= 8;
    top = above ? overWord : Math.max(8, vh - bh - 8);
  }

  /* しっぽの先は TAIL_INSET だけ内側にある。そこが語の真ん中に来るよう左端を
     決め、画面からはみ出す分だけ戻す */
  const apex = point.x;
  const left = Math.min(Math.max(8, apex - TAIL_INSET), Math.max(8, vw - bw - 8));
  /* 端に寄せて動かした分は、しっぽの位置で吸収して指し先を語に残す。角を丸めて
     いるときは、丸みの上にしっぽが乗らないところまで */
  const radius = parseFloat(getComputedStyle(bubble).borderTopLeftRadius) || 0;
  const minTail = Math.max(8, radius + 4);
  const tailX = Math.min(Math.max(apex - left, minTail), Math.max(minTail, bw - 26));
  bubble.style.setProperty("--tail-x", `${Math.round(tailX)}px`);
  bubble.classList.toggle("up", above);

  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}

function queuePlace() {
  if (placeQueued || !ui || ui.bubble.hidden) return;
  placeQueued = true;
  requestAnimationFrame(() => {
    placeQueued = false;
    if (ui && !ui.bubble.hidden) place();
  });
}

/* ------------------------------------------------------------------ *
 * 吹き出しの中身
 * ------------------------------------------------------------------ */
function render({ kind, message = "", note = "" }) {
  ensureUI();
  applyBubbleLook();
  ui.note.textContent = note;
  ui.body.classList.toggle("err", kind === "error");
  ui.body.classList.toggle("wait", kind === "loading" || kind === "ask");

  if (kind === "loading") {
    ui.body.textContent = "訳しています…";
  } else {
    ui.body.textContent = kind === "ok" ? translation : message;
  }

  ui.ask.hidden = kind !== "ask";
  /* 訳が出せなかったときでも、単語なら本体アプリへは行ける */
  ui.engoloyd.hidden = !shownWord;
  ui.settings.hidden = !(kind === "error" && showSettingsFlag);
  ui.foot.hidden = ui.ask.hidden && ui.engoloyd.hidden && ui.settings.hidden && !note;

  ui.bubble.hidden = false;
  place();
  /* 文字が回り込んで高さが変わることがあるので、描かれた後にもう一度合わせる */
  requestAnimationFrame(place);
}

function hide() {
  seq += 1;
  anchor = null;
  shownText = "";
  shownWord = "";
  translation = "";
  hoverSource = false;
  clearHoverTimers();
  hoverPoint = null;
  if (ui) ui.bubble.hidden = true;
}

/* ------------------------------------------------------------------ *
 * 訳を頼む
 * ------------------------------------------------------------------ */
/* wait は頼むまでに置く間。いまは誰も渡していない（カーソルを合わせたときは
   合わせている間に待ち終えていて、選んだときは待たせない）が、置き場所として
   残してある */
async function startTranslate(text, { wait = 0 } = {}) {
  if (!text) return;
  const mine = ++seq;
  translation = "";
  showSettingsFlag = false;
  render({ kind: "loading" });

  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  if (mine !== seq) return;

  let res;
  try {
    res = await browser.runtime.sendMessage({ type: "translate", text });
  } catch {
    res = { ok: false, message: "拡張機能の裏側と話せませんでした。Firefoxを開き直してください" };
  }
  if (mine !== seq) return;

  if (res && res.ok) {
    translation = res.translation;
    render({ kind: "ok", note: res.via || "" });
  } else {
    showSettingsFlag = Boolean(res && res.showSettings);
    render({ kind: "error", message: (res && res.message) || "訳せませんでした" });
  }
}

/* ------------------------------------------------------------------ *
 * カーソルを合わせて意味を出す
 *    選ぶ手間が要らない代わりに、動かしている最中に出ては邪魔でしかない。
 *    同じ字の上で手が止まってから出す
 * ------------------------------------------------------------------ */
/* 手の震えで数え直していると、いつまでも時間が貯まらない */
const HOVER_JITTER_PX = 6;
/* 語から離れた瞬間に消すと、吹き出しの中の釦を押しに行けない */
const HOVER_LEAVE_MS = 300;
const HOVER_LEAVE_MARGIN_PX = 24;

function clearHoverTimers() {
  clearTimeout(hoverTimer);
  clearTimeout(hoverLeaveTimer);
  hoverTimer = null;
  hoverLeaveTimer = null;
}

/* その座標にある英単語を、端まで広げて取り出す */
function wordAtPoint(x, y) {
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y);
    if (!position) return null;
    node = position.offsetNode;
    offset = position.offset;
  } else if (document.caretRangeFromPoint) {
    /* Chromium系にはこちらしか無い。テストはそちらで動かしている */
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  /* 入力欄の中身は書きかけの文であることが多く、合わせただけで訳すと邪魔 */
  if (node.parentElement && node.parentElement.closest("input, textarea")) return null;

  const text = node.nodeValue || "";
  const isWordChar = (ch) => /[A-Za-z'\u2019-]/.test(ch);
  let start = Math.min(offset, text.length);
  let end = start;
  while (start > 0 && isWordChar(text[start - 1])) start -= 1;
  while (end < text.length && isWordChar(text[end])) end += 1;
  if (end - start < 2) return null;

  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const rect = range.getBoundingClientRect();
  /* 字の無い余白でも、いちばん近い場所を返してくる。本当にその字の上に
     居るときだけ相手にする */
  if (x < rect.left - 2 || x > rect.right + 2 || y < rect.top - 2 || y > rect.bottom + 2) return null;

  const word = wordOf(range.toString());
  if (!word) return null;
  return { word, range };
}

/* 手が止まって一秒 */
function onDwell(point) {
  hoverTimer = null;
  if (!settings.hover) return;
  /* 選んで出した吹き出しが出ているなら、そちらを立てる */
  if (ui && !ui.bubble.hidden && !hoverSource) return;

  const found = wordAtPoint(point.x, point.y);
  if (!found || !looksTranslatable(found.word)) return;
  /* 同じ語で出し直すと、覚えている訳でも一度消えて瞬く */
  if (hoverSource && found.word === shownText && ui && !ui.bubble.hidden) return;

  hoverSource = true;
  anchor = {
    text: found.word,
    rectOf: () => found.range.getBoundingClientRect(),
    pointOf: () => rangeAim(found.range),
  };
  shownText = found.word;
  shownWord = found.word;
  translation = "";
  showSettingsFlag = false;
  startTranslate(found.word);
}

/* ------------------------------------------------------------------ *
 * ページ側の出来事
 * ------------------------------------------------------------------ */
function insideUI(event) {
  if (!host) return false;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  return path.includes(host) || event.target === host;
}

function handleSelection(target) {
  const picked = readSelection(target);
  if (!picked) {
    hide();
    return;
  }
  const text = picked.text.trim().replace(/\s+/g, " ");
  if (!looksTranslatable(text)) {
    hide();
    return;
  }
  /* 同じ範囲を選び直しただけなら、出ている物をそのままにする */
  if (text === shownText && ui && !ui.bubble.hidden) {
    anchor = picked;
    return;
  }

  anchor = picked;
  shownText = text;
  shownWord = wordOf(text);
  translation = "";
  showSettingsFlag = false;
  hoverSource = false;
  clearHoverTimers();

  if (text.length > MAX_CHARS) {
    seq += 1;
    render({ kind: "error", message: `選んだ範囲が長すぎます（${MAX_CHARS}字まで）` });
    return;
  }
  if (settings.trigger === "button") {
    seq += 1;
    render({ kind: "ask", message: "" });
    return;
  }
  /* 選ぶという手間がもう掛かっているので、ここでは待たせない */
  startTranslate(text);
}

/* ページ側が止めてしまう作りでも拾えるよう、降りていく段階（capture）で聞く */
document.addEventListener("mouseup", (event) => {
  if (!settings.enabled || insideUI(event)) return;
  /* 選択が確定するのは mouseup の後。ひと呼吸おいてから読む */
  const target = event.target;
  setTimeout(() => handleSelection(target), 0);
}, true);

document.addEventListener("mousemove", (event) => {
  if (!settings.hover) return;
  /* 吹き出しの上に居る間は引っ込めない。中の釦を押しに行けなくなる */
  if (insideUI(event)) {
    clearTimeout(hoverLeaveTimer);
    hoverLeaveTimer = null;
    return;
  }
  const point = { x: event.clientX, y: event.clientY };

  /* 合わせて出した吹き出しは、その語から離れたら引っ込める */
  if (hoverSource && ui && !ui.bubble.hidden) {
    const rect = currentRect();
    const away =
      !rect ||
      point.x < rect.left - HOVER_LEAVE_MARGIN_PX || point.x > rect.right + HOVER_LEAVE_MARGIN_PX ||
      point.y < rect.top - HOVER_LEAVE_MARGIN_PX || point.y > rect.bottom + HOVER_LEAVE_MARGIN_PX;
    if (away && !hoverLeaveTimer) {
      hoverLeaveTimer = setTimeout(() => {
        hoverLeaveTimer = null;
        if (hoverSource) hide();
      }, HOVER_LEAVE_MS);
    } else if (!away && hoverLeaveTimer) {
      clearTimeout(hoverLeaveTimer);
      hoverLeaveTimer = null;
    }
  }

  /* ほとんど動いていないなら数え直さない */
  if (
    hoverPoint &&
    Math.abs(point.x - hoverPoint.x) <= HOVER_JITTER_PX &&
    Math.abs(point.y - hoverPoint.y) <= HOVER_JITTER_PX
  ) {
    return;
  }
  hoverPoint = point;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => onDwell(point), waitMs());
}, { capture: true, passive: true });

document.addEventListener("mousedown", (event) => {
  if (insideUI(event)) return;
  hide();
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && ui && !ui.bubble.hidden) hide();
}, true);

window.addEventListener("scroll", () => {
  /* 動いた先の字は、合わせていた字とは別物 */
  clearTimeout(hoverTimer);
  hoverTimer = null;
  queuePlace();
}, { capture: true, passive: true });
window.addEventListener("resize", queuePlace, { passive: true });
