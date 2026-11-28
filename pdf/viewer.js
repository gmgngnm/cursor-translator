/* 自前のPDFビューア。描くのは pdf.js、書き込むのは pdf-lib（どちらも vendor/ に
   そのまま置いてある）。ここは「開く・めくる・線を引く・保存する」を受け持つ。
   このページは拡張機能自身のページなので content.js をそのまま読み込める。
   Firefox の内蔵ビューアは resource:// のページで、そこには差し込めない */
import * as pdfjsLib from "./vendor/pdf.min.mjs";

/* 表示部品（pdf_viewer.mjs）は globalThis.pdfjsLib を見に行く作りなので、
   先に置いてから読み込む */
globalThis.pdfjsLib = pdfjsLib;
const { EventBus, PDFViewer, PDFLinkService } = await import("./vendor/pdf_viewer.mjs");

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.mjs";

const el = {};
for (const id of ["open", "file", "name", "marker", "color", "page", "scale", "in", "out",
                  "save", "note", "viewerContainer", "editor", "text", "apply", "drop", "close",
                  "vocab", "vocabulary", "vocab-list", "vocab-count", "vocab-empty", "vocab-close",
                  "note-text", "note-close", "said"]) {
  /* vocab-list のような名前は、使うときに el["vocab-list"] と書く */
  el[id] = document.getElementById(id);
}

/* ------------------------------------------------------------------ *
 * いま開いている物
 * ------------------------------------------------------------------ */
/* 保存のたびに、元のPDFに今ある線を全部引き直して書き出す。差分を積み上げると
   二度保存したときに線が二重になる */
let originalBytes = null;
let fileName = "";
let marks = [];
let dirty = false;
let picked = null;          // いま注釈を書いている線
let saveHandle = null;      // 上書き先（この仕組みを持つブラウザでだけ使う）
let autoTimer = null;
let nextId = 1;
let wantPage = 0;          // 開いたとき、どのページから始めるか
let pageTimer = null;
let drawnAt = 0;          // 線を引き終えた時刻。その直後の押しは拾わない

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const viewer = new PDFViewer({
  container: el.viewerContainer,
  viewer: document.getElementById("viewer"),
  eventBus,
  linkService,
  /* pdf.js の書き込み道具は使わない。線はこちらで持つ */
  annotationEditorMode: 0,
  /* よそのPDFに入っている付箋などの絵の置き場。渡さないとページの直下を
     探しに行き、見つからず「[Comment Annotation]」のような代替文字が出る */
  imageResourcesPath: "vendor/images/",
});
linkService.setViewer(viewer);

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = "page-width";
  /* 前に見ていたページから始める。読みかけの資料を開くたびに
     めくり直すのは手間なので */
  if (wantPage > 1) viewer.currentPageNumber = Math.min(wantPage, viewer.pagesCount);
  wantPage = 0;
  showScale();
  fillPages();
  drawMarks();
});
eventBus.on("scalechanging", () => { showScale(); drawMarks(); });
eventBus.on("pagechanging", () => {
  el.page.value = String(viewer.currentPageNumber);
  /* めくるたびに書くと、送っている間じゅう書き続けることになる。
     手が止まってから書く */
  clearTimeout(pageTimer);
  pageTimer = setTimeout(rememberPage, 500);
});
eventBus.on("pagerendered", drawMarks);

function showScale() {
  el.scale.textContent = `${Math.round(viewer.currentScale * 100)}%`;
}

function fillPages() {
  const options = [];
  for (let n = 1; n <= viewer.pagesCount; n += 1) {
    const option = document.createElement("option");
    option.value = String(n);
    option.textContent = `${n} / ${viewer.pagesCount}`;
    options.push(option);
  }
  el.page.replaceChildren(...options);
  el.page.value = String(viewer.currentPageNumber);
}

/* 添え字の一行。困りごと（bad）は赤く、ただの知らせは控えめに出す */
/* 前に見ていたページは、ファイルの名前で覚える。同じ名前の別の資料だと
   取り違えるが、ページ数で頭打ちにしてあるので行き過ぎることはない */
const PAGE_MEMORY = "pdfLastPage";
const PAGE_MEMORY_MAX = 50;   // 覚えておく資料の数。溜め込み続けないため

async function rememberPage() {
  if (!fileName || !viewer.pagesCount) return;
  try {
    const store = await browser.storage.local.get({ [PAGE_MEMORY]: {} });
    const map = Object.assign({}, store[PAGE_MEMORY]);
    map[fileName] = { page: viewer.currentPageNumber, at: Date.now() };
    const recent = Object.keys(map).sort((a, b) => (map[b].at || 0) - (map[a].at || 0));
    const kept = {};
    for (const name of recent.slice(0, PAGE_MEMORY_MAX)) kept[name] = map[name];
    await browser.storage.local.set({ [PAGE_MEMORY]: kept });
  } catch (err) {
    /* 覚えられなくても読むことはできる。黙って諦める */
    console.warn("開いていたページを覚えられませんでした:", err);
  }
}

async function rememberedPage(label) {
  try {
    const store = await browser.storage.local.get({ [PAGE_MEMORY]: {} });
    const row = (store[PAGE_MEMORY] || {})[label];
    return row && row.page > 0 ? row.page : 0;
  } catch {
    return 0;
  }
}

/* 添え字の一行。困りごと（bad）は赤く、ただの知らせは控えめに出す。
   読み終わったら × で消せる。出しっぱなしだと紙が狭いままになる */
function say(message, bad = false) {
  el["note-text"].textContent = message || "";
  el.note.classList.toggle("bad", Boolean(message) && bad);
  el.note.hidden = !message;
}

/* 未保存かどうかは、ファイル名のうしろの * で示す。札を別に置くと場所を取る */
function showName() {
  el.name.textContent = fileName ? `${fileName}${dirty ? " *" : ""}` : "";
  el.name.classList.toggle("dirty", dirty);
  document.title = fileName
    ? `${dirty ? "*" : ""}${fileName} — Cursor Translator`
    : "Cursor Translator — PDF";
}

function setDirty(value) {
  dirty = value;
  showName();
}

/* ------------------------------------------------------------------ *
 * 戻す（Ctrl+Z）
 *
 * 線の一覧をまるごと控えて、戻すときはそこへ戻す。線は数も中身も小さいので、
 * 何をどう変えたかを細かく覚えるより、この方が取り違えが無い。
 * ------------------------------------------------------------------ */
const HISTORY_MAX = 50;   // 控えておく手数。際限なく溜めないため
const history = [];
/* 最後に保存したときの姿。これと見比べて「未保存」を決める。
   戻して元の姿に戻ったときに、未保存のままにしないため */
let savedState = "[]";

function stamp() {
  return JSON.stringify(marks);
}

/* 変える前に呼ぶ */
function remember() {
  history.push(stamp());
  if (history.length > HISTORY_MAX) history.shift();
}

/* 変えた後に呼ぶ。保存したときの姿と同じなら、未保存ではない */
function touched() {
  setDirty(stamp() !== savedState);
  drawVocab();
}

function undo() {
  if (!history.length) {
    say("Nothing to undo.");
    return;
  }
  marks = JSON.parse(history.pop());
  /* 戻した線の番号とぶつからないよう、次の番号を先へ送る */
  for (const mark of marks) nextId = Math.max(nextId, mark.id + 1);
  hideEditor();
  drawMarks();
  touched();
  if (!history.length) say("");
}

/* ------------------------------------------------------------------ *
 * 開く
 * ------------------------------------------------------------------ */
async function show(bytes, label, handle = null) {
  say("");
  fileName = label;
  dirty = false;
  picked = null;
  saveHandle = handle;
  hideEditor();
  setDirty(false);
  showName();
  /* 前にこのPDFへ引いた線は、注釈として入っている。剥がしてこちらの持ち物に
     移すと、そのまま消したり覚え書きを書き直したりできる */
  const taken = await takeMarksOut(bytes);
  originalBytes = taken.bare;
  marks = taken.found;
  wantPage = await rememberedPage(label);
  /* 開いた時点の姿を、未保存かどうかの基準にする。戻す手数も持ち越さない */
  savedState = stamp();
  history.length = 0;
  drawVocab();
  if (taken.found.length) say(`Loaded ${taken.found.length} highlight${taken.found.length > 1 ? "s" : ""}.`);
  try {
    /* pdf.js は渡した配列を自分の物として使ってしまう（中身が空になる）。
       保存のときに元の姿が要るので、写しを渡す */
    const task = pdfjsLib.getDocument({ data: originalBytes.slice() });
    const doc = await task.promise;
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
  } catch (err) {
    console.warn("PDFを開けませんでした:", err);
    say(`Could not open: ${err && err.message ? err.message : err}`, true);
  }
}

async function openUrl(url) {
  try {
    /* 鍵の要るページに置かれたPDFもあるので、ログインの記録を付けて取りに行く */
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    show(bytes, decodeURIComponent((url.split("/").pop() || "download").split("?")[0]));
  } catch (err) {
    say(`Could not fetch: ${err && err.message ? err.message : err}`, true);
  }
}

el.open.addEventListener("click", async () => {
  /* 上書きできる仕組みを持つブラウザなら、開いた先をそのまま保存先にする */
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
      });
      const file = await handle.getFile();
      show(new Uint8Array(await file.arrayBuffer()), file.name, handle);
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  el.file.click();
});

el.file.addEventListener("change", async () => {
  const file = el.file.files && el.file.files[0];
  if (!file) return;
  /* 手元のファイルは読み込んでしまう。file:// を開くわけではないので、
     「ローカルファイルへのアクセス」の許可は要らない */
  show(new Uint8Array(await file.arrayBuffer()), file.name);
});

el.page.addEventListener("change", () => {
  viewer.currentPageNumber = Number(el.page.value) || 1;
});
el.in.addEventListener("click", () => { viewer.currentScale = Math.min(viewer.currentScale * 1.1, 10); });
el.out.addEventListener("click", () => { viewer.currentScale = Math.max(viewer.currentScale / 1.1, 0.1); });

/* ------------------------------------------------------------------ *
 * 線を引く
 * ------------------------------------------------------------------ */
function pageOf(node) {
  const element = node && (node.nodeType === 1 ? node : node.parentElement);
  return element ? element.closest(".page") : null;
}

/* 選んだ範囲の箱を、行ごとに1つへまとめる。
   getClientRects() は字の塊ごとに箱を返し、その高さは字によって違う
   （（ ）のような約物は、同じ行の仮名より背の高い箱になる）。そのまま引くと
   線が凸凹する。縦に重なっている箱を同じ行とみなして、その行を覆う長方形を
   1つだけ返す */
function lineBands(rectList) {
  const lines = [];
  for (const rect of rectList) {
    if (rect.width < 1 || rect.height < 1) continue;
    /* 低い方の高さの半分より深く重なっていれば同じ行。行間が空いていれば
       この条件を満たさないので、隣の行まで繋がることはない */
    const line = lines.find((l) => {
      const overlap = Math.min(l.bottom, rect.bottom) - Math.max(l.top, rect.top);
      return overlap > Math.min(l.bottom - l.top, rect.height) / 2;
    });
    if (!line) {
      lines.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
      continue;
    }
    /* 行を覆うように広げる。狭める向きには動かさない（字が線からはみ出す） */
    line.top = Math.min(line.top, rect.top);
    line.bottom = Math.max(line.bottom, rect.bottom);
    line.left = Math.min(line.left, rect.left);
    line.right = Math.max(line.right, rect.right);
  }
  return lines;
}

/* 画面の座標をPDFの座標に直して持つ。拡大しても紙の同じ場所に残るように */
function marksFromSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
  return marksFromRange(selection.getRangeAt(0));
}

function marksFromRange(range) {
  if (!range) return [];
  const made = new Map();
  for (const rect of lineBands(range.getClientRects())) {
    const pageDiv = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    const page = pageOf(pageDiv) || pageOf(range.startContainer);
    if (!page) continue;
    const num = Number(page.dataset.pageNumber);
    const view = viewer.getPageView(num - 1);
    if (!view || !view.viewport) continue;
    const box = page.getBoundingClientRect();
    /* 紙には枠を付けているので、その分をずらす */
    const left = box.left + page.clientLeft;
    const top = box.top + page.clientTop;
    const [x1, y1] = view.viewport.convertToPdfPoint(rect.left - left, rect.top - top);
    const [x2, y2] = view.viewport.convertToPdfPoint(rect.right - left, rect.bottom - top);
    if (!made.has(num)) made.set(num, []);
    made.get(num).push({
      x: Math.min(x1, x2), y: Math.min(y1, y2),
      w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    });
  }
  /* 元の文字列も持っておく。あとでカーソルを乗せたときに、覚えてある訳を
     引くのに使う。行をまたいだときの繋ぎ方は、訳すときと同じ手で揃える */
  /* 行の継ぎ目の繋ぎ方は content.js の物に合わせる（同じ所で動いている）。
     読み込みの順で居なければ、素の文字列で我慢する */
  const text = typeof textOfRange === "function" ? textOfRange(range) : range.toString();
  return [...made.entries()].map(([page, rects]) => ({
    id: nextId++, page, rects, color: el.color.value, note: "", text, said: "",
  }));
}

function drawMarks() {
  for (let n = 1; n <= viewer.pagesCount; n += 1) {
    const view = viewer.getPageView(n - 1);
    if (!view || !view.div) continue;
    let layer = view.div.querySelector(".markLayer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "markLayer";
    }
    /* **置き場所は毎回決め直す。**
       紙(canvas)より前に来ると、不透明な紙に隠れて線が見えなくなる。それでも
       押せてしまう（押す先は重なりを貫いて探すため）ので、「当たり判定はあるのに
       見えない」という分かりにくい姿になる。
       pdf.js は描き直すたびに自分の層を足し直すので、いちど置いた場所に留まって
       くれない。紙のすぐ後ろに置き直して、紙より上・字の層より下を保つ。
       z-index では上げない。付けると層が独立して下の紙と混ざらなくなり、
       蛍光ペンのつもりが字を塗りつぶす */
    const paper = view.div.querySelector(".canvasWrapper");
    if (paper) {
      if (layer.previousElementSibling !== paper) paper.after(layer);
    } else if (layer.parentElement !== view.div) {
      /* 紙がまだ無いうちは先頭でよい。次に描くときに置き直される */
      view.div.prepend(layer);
    }
    const boxes = [];
    for (const mark of marks) {
      if (mark.page !== n) continue;
      for (const rect of mark.rects) {
        const [x1, y1, x2, y2] = view.viewport.convertToViewportRectangle([
          rect.x, rect.y, rect.x + rect.w, rect.y + rect.h,
        ]);
        const box = document.createElement("div");
        box.className = mark.note ? "mark noted" : "mark";
        box.dataset.id = String(mark.id);
        box.style.left = `${Math.min(x1, x2)}px`;
        box.style.top = `${Math.min(y1, y2)}px`;
        box.style.width = `${Math.abs(x2 - x1)}px`;
        box.style.height = `${Math.abs(y2 - y1)}px`;
        box.style.background = mark.color;
        boxes.push(box);
      }
    }
    layer.replaceChildren(...boxes);
  }
}

/* 文字を選んでから「マーカー」を押すと、そこに線が引かれる。
   押した拍子に選択が解けてしまうと引く先が無くなるので、mousedown の既定の
   動きを止める（焦点が移らなければ選択はそのまま残る） */
el.marker.addEventListener("mousedown", (event) => event.preventDefault());
el.marker.addEventListener("click", () => {
  if (!applyMarker()) say("Select some text first.");
});

/* 渡されたところに線を引く。何も渡さなければ、いま選んでいるところ。
   引けたら true */
function applyMarker(range = null) {
  const made = range ? marksFromRange(range) : marksFromSelection();
  if (!made.length) return false;
  remember();
  marks.push(...made);
  /* 引いたら選択は解く。引いた線が選択の青に隠れて見えないため */
  window.getSelection().removeAllRanges();
  drawnAt = Date.now();
  drawMarks();
  touched();
  say("");
  return true;
}

/* 選んだところを右クリックしても引ける。釦まで手を動かさずに済む。
   紙の上で、かつ何か選んでいるときだけ横取りする。選んでいなければ
   いつもの右クリックの献立をそのまま出す */
document.addEventListener("contextmenu", (event) => {
  if (!el.viewerContainer.contains(event.target)) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) {
    if (applyMarker()) event.preventDefault();
    return;
  }
  /* 何も選んでいないときは、**カーソルの下の語**に引く。読みながら、知らない語を
     その場で拾っていけるように。
     前は「いま吹き出しを出している語」を content.js に尋ねていたが、吹き出しが
     出ているかどうかで結果が変わり、当てにならなかった（出ているのに引けない、
     という目に遭う）。同じ所で動いているので、語を探す手を直に呼ぶ。
     余白や絵の上では何も返らないので、そこはいつもの献立がそのまま出る */
  const found = typeof wordAtPoint === "function" ? wordAtPoint(event.clientX, event.clientY) : null;
  if (!found || !found.range) return;
  if (!applyMarker(found.range)) return;
  event.preventDefault();
});

/* ------------------------------------------------------------------ *
 * 線に触れたら、覚えてある訳を出す
 *
 * ハイライト翻訳が入っていれば、カーソルタッチ翻訳の入切に関わらず出す。
 * いちど引いた線は「もう訳した物」なので、読み返すたびに訳を待たされたり、
 * 訳す相手を呼び直したりするのは無駄。覚えてある分だけを出す
 * ------------------------------------------------------------------ */
let hoveredMark = 0;
let shownMark = 0;          // こちらが訳を出させた線。離れたら引っ込める
/* 吹き出しの入れ物。中に居るあいだは引っ込めない */
const BUBBLE_HOST = "engoloyd-select-to-ja";

function markAt(x, y) {
  const box = document.elementsFromPoint(x, y)
    .find((node) => node.classList && node.classList.contains("mark"));
  if (!box) return null;
  return marks.find((m) => m.id === Number(box.dataset.id)) || null;
}

document.addEventListener("mousemove", async (event) => {
  /* 吹き出しの上に居るあいだはそのまま。中の釦を押しに行けるように
     （影の中の出来事は、入れ物そのものから出たことになる） */
  if (event.target && event.target.closest && event.target.closest(`#${BUBBLE_HOST}`)) return;
  const inside = el.viewerContainer.contains(event.target);
  const mark = inside ? markAt(event.clientX, event.clientY) : null;
  if (!mark || !mark.text) {
    hoveredMark = 0;
    /* 線から離れた。こちらが出させた訳は、その場で引っ込める。
       待ってから消えると、次に読む行に被ったままになる */
    if (shownMark) {
      shownMark = 0;
      document.dispatchEvent(new CustomEvent("engoloyd-hide"));
    }
    return;
  }
  if (hoveredMark === mark.id) return;      // 同じ線の上を動いているだけ
  hoveredMark = mark.id;
  const settings = await loadSettings();
  if (!settings.enabled) return;            // ハイライト翻訳が切ってある
  /* 書き換えた意味があれば、覚えより先に立てる。思った意味でない訳が
     出てしまうことがあるので、そこは利用者が決められるようにしてある */
  let res = mark.said ? { ok: true, translation: mark.said, via: "yours" } : null;
  if (!res) {
    try {
      res = await browser.runtime.sendMessage({ type: "recall", text: mark.text });
    } catch {
      res = null;
    }
  }
  if (hoveredMark !== mark.id) return;      // 待っている間に離れた
  const box = document.querySelector(`.markLayer .mark[data-id="${mark.id}"]`);
  if (!box) return;
  /* 覚えていればそれを出す。まだ訳していなければ訳しに行かせる。
     どちらにしても待ち時間は掛けない（線を引いたのは利用者がそこを選んだ
     ということなので、読み流しと同じに扱わない） */
  shownMark = mark.id;
  document.dispatchEvent(new CustomEvent("engoloyd-show", {
    detail: {
      text: mark.text,
      translation: res && res.ok ? res.translation : "",
      via: res && res.ok ? res.via : "",
      rect: box.getBoundingClientRect(),
    },
  }));
});

/* 線は字の層の下に敷いてあるので、押して当たるのは字の方。押した点の真下まで
   見に行って、線があればその線の覚え書きを開く */
document.addEventListener("click", (event) => {
  if (el.editor.contains(event.target) || event.target === el.marker) return;
  /* 引いた直後の押しは、いま引いた線の欄をいきなり開いてしまうので見送る */
  if (Date.now() - drawnAt < 400) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;   // なぞっただけ
  const box = document.elementsFromPoint(event.clientX, event.clientY)
    .find((node) => node.classList && node.classList.contains("mark"));
  if (!box) return;
  const mark = marks.find((m) => m.id === Number(box.dataset.id));
  if (!mark) return;
  picked = mark;
  el.text.value = mark.note;
  /* 見えている意味をそのまま入れておく。書き換えたい人は直せばよく、
     触らなければ元のままになる */
  el.said.value = mark.said || "";
  if (!el.said.value && mark.text) {
    const asked = mark.id;
    browser.runtime.sendMessage({ type: "recall", text: mark.text })
      .then((res) => {
        /* 待っている間に別の線へ移っていたら、入れない */
        if (picked && picked.id === asked && !el.said.value && res && res.ok) {
          el.said.value = res.translation;
        }
      })
      .catch(() => { /* 覚えを引けなくても書き込みはできる */ });
  }
  const rect = box.getBoundingClientRect();
  el.editor.hidden = false;
  el.editor.style.left = `${Math.min(rect.left, window.innerWidth - 250)}px`;
  el.editor.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 160)}px`;
  el.said.focus();
  el.said.select();
});

function hideEditor() {
  el.editor.hidden = true;
  picked = null;
}

el.apply.addEventListener("click", () => {
  if (!picked) return;
  remember();
  picked.note = el.text.value.trim();
  picked.said = el.said.value.trim();
  hideEditor();
  drawMarks();
  touched();
});
el.drop.addEventListener("click", () => {
  if (!picked) return;
  remember();
  marks = marks.filter((m) => m.id !== picked.id);
  hideEditor();
  drawMarks();
  touched();
});
el.close.addEventListener("click", hideEditor);

/* 欄の中で Enter を押したら、釦を押さずに書き込みを済ませる。
   意味は一行なので Enter そのまま。覚え書きは行を変えたいことがあるので、
   そちらは Ctrl+Enter（Mac では Cmd+Enter）。
   釦に焦点があるときは、その釦の仕事をそのままさせる */
el.editor.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (event.target.tagName === "BUTTON") return;
  if (event.target === el.text && !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  el.apply.click();
});

/* ------------------------------------------------------------------ *
 * vocabulary（引いた線の一覧）
 *
 * 右から出す。読み終わったあとに、拾った語をまとめて見返すためのもの。
 * 訳は覚えてある分だけを出す。ここを開いたせいで訳す相手を呼ぶことはない
 * ------------------------------------------------------------------ */
function vocabOpen() {
  return !el.vocabulary.hidden;
}

async function drawVocab() {
  if (!vocabOpen()) return;
  const list = el["vocab-list"];
  const rows = [];
  /* 引いた順ではなく、紙に並んでいる順で出す。読み返すときはその方が追える */
  const ordered = [...marks].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    /* PDFの縦は下が0なので、上にある物ほど値が大きい */
    return (b.rects[0] ? b.rects[0].y : 0) - (a.rects[0] ? a.rects[0].y : 0);
  });
  for (const mark of ordered) {
    const row = document.createElement("li");
    row.className = "pdfside-row";
    row.dataset.id = String(mark.id);

    const swatch = document.createElement("span");
    swatch.className = "pdfside-dot";
    swatch.style.background = mark.color;

    const body = document.createElement("div");
    body.className = "pdfside-body";

    const head = document.createElement("b");
    head.className = "pdfside-text";
    head.textContent = mark.text || "(no text)";
    body.append(head);

    /* 書き換えた意味があればそれを。無ければ覚えてある分だけ */
    let said = mark.said || "";
    if (!said && mark.text) {
      try {
        const res = await browser.runtime.sendMessage({ type: "recall", text: mark.text });
        if (res && res.ok) said = res.translation;
      } catch { /* 裏方と話せなくても一覧は出す */ }
    }
    if (said) {
      const line = document.createElement("div");
      line.className = "pdfside-said";
      line.textContent = said;
      body.append(line);
    }
    if (mark.note) {
      const line = document.createElement("div");
      line.className = "pdfside-note";
      line.textContent = mark.note;
      body.append(line);
    }

    const page = document.createElement("span");
    page.className = "pdfside-page";
    page.textContent = `p.${mark.page}`;

    row.append(swatch, body, page);
    rows.push(row);
  }
  list.replaceChildren(...rows);
  el["vocab-count"].textContent = marks.length ? String(marks.length) : "";
  el["vocab-empty"].hidden = marks.length > 0;
}

function toggleVocab(open) {
  const want = open === undefined ? !vocabOpen() : open;
  el.vocabulary.hidden = !want;
  el.vocab.setAttribute("aria-expanded", String(want));
  document.body.classList.toggle("with-side", want);
  if (want) drawVocab();
}

el["note-close"].addEventListener("click", () => say(""));

el.vocab.addEventListener("click", () => toggleVocab());
el["vocab-close"].addEventListener("click", () => toggleVocab(false));

/* 押したらその線まで連れて行く */
el["vocab-list"].addEventListener("click", (event) => {
  const row = event.target.closest(".pdfside-row");
  if (!row) return;
  const mark = marks.find((m) => m.id === Number(row.dataset.id));
  if (!mark) return;
  viewer.currentPageNumber = mark.page;
  const box = document.querySelector(`.markLayer .mark[data-id="${mark.id}"]`);
  if (box) box.scrollIntoView({ block: "center" });
});

/* ------------------------------------------------------------------ *
 * 保存と読み戻し
 *
 * 線は **PDFの注釈（Highlight）として持つ**。紙そのものに描き込むと、
 * 一度保存したあとは消すことも直すこともできなくなる（開き直したときに
 * 「どこが線か」を知る手立てが無い）。注釈なら読み戻せるので、前に引いた線を
 * 消したり覚え書きを書き直したりできる。
 * 見た目(AP)も一緒に書いておく。これが無いと、注釈を自分で描かない道具では
 * 何も出ない。
 * ------------------------------------------------------------------ */
const MINE = "Cursor Translator";   // うちが付けた注釈の目印（注釈の T に入れる）

function pdfLib() {
  return import("./vendor/pdf-lib.esm.min.js");
}

function hex(color) {
  const n = parseInt((color || "#ff777a").slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toHex([r, g, b]) {
  const part = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/* 1つの線を Highlight の注釈にする。行ごとの長方形は QuadPoints に並べる */
function markToAnnot(doc, mark, lib) {
  const { PDFHexString, PDFRawStream, typedArrayFor } = lib;
  const [r, g, b] = hex(mark.color);
  const quads = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const rect of mark.rects) {
    const left = rect.x, bottom = rect.y, right = rect.x + rect.w, top = rect.y + rect.h;
    /* QuadPoints の並びは 左上・右上・左下・右下 */
    quads.push(left, top, right, top, left, bottom, right, bottom);
    x0 = Math.min(x0, left); y0 = Math.min(y0, bottom);
    x1 = Math.max(x1, right); y1 = Math.max(y1, top);
  }
  /* 見た目。紙に直接ではなく、この注釈の中に描く。
     文字が透けるのは乗算（Multiply）のおかげで、薄める必要は無い。
     薄めると、画面で見ている線より淡い物が書き出されて食い違う */
  const ops = ["/GS gs", `${r} ${g} ${b} rg`,
    ...mark.rects.map((c) => `${c.x} ${c.y} ${c.w} ${c.h} re f`)].join("\n");
  const contents = typedArrayFor(ops);
  const form = PDFRawStream.of(doc.context.obj({
    Type: "XObject", Subtype: "Form", FormType: 1,
    BBox: [x0, y0, x1, y1],
    Resources: { ExtGState: { GS: { Type: "ExtGState", BM: "Multiply" } } },
    Length: contents.length,
  }), contents);
  return doc.context.obj({
    Type: "Annot", Subtype: "Highlight",
    Rect: [x0, y0, x1, y1],
    QuadPoints: quads,
    C: [r, g, b],
    F: 4,
    T: PDFHexString.fromText(MINE),
    Contents: PDFHexString.fromText(mark.note || ""),
    /* 線を引いた元の文字列。PDFの決まりには無い項だが、知らない項は
       読み飛ばす決まりなので、他の道具の邪魔にはならない。
       これが無いと、開き直したあとに訳を引く手がかりが無くなる */
    Subj: PDFHexString.fromText(mark.text || ""),
    /* 書き換えた意味。空なら覚えてある訳をそのまま使う。
       うちだけが読む項なので、名前がぶつからないように CT を冠する */
    CTMeaning: PDFHexString.fromText(mark.said || ""),
    AP: { N: doc.context.register(form) },
  });
}

/* 注釈の中の一項を読む。PDFは値を「別の物」として置くことがあり、そのときは
   辿らないと中身に行き着けない（本物のPDFではよくある形） */
function entry(doc, dict, key, lib) {
  if (!dict || typeof dict.get !== "function") return null;
  const value = dict.get(lib.PDFName.of(key));
  if (value === undefined || value === null) return null;
  try {
    return doc.context.lookup(value);
  } catch {
    return null;
  }
}

/* うちが付けた注釈かどうか。他の道具が付けた注釈には触らない */
function isMine(doc, dict, lib) {
  const title = entry(doc, dict, "T", lib);
  return Boolean(title && typeof title.decodeText === "function" && title.decodeText() === MINE);
}

function annotToMark(doc, dict, pageNumber, lib) {
  const quad = entry(doc, dict, "QuadPoints", lib);
  if (!quad || !quad.asArray) return null;
  const numbers = quad.asArray().map((n) => doc.context.lookup(n)).map((n) => n.asNumber());
  const rects = [];
  for (let i = 0; i + 7 < numbers.length; i += 8) {
    const xs = [numbers[i], numbers[i + 2], numbers[i + 4], numbers[i + 6]];
    const ys = [numbers[i + 1], numbers[i + 3], numbers[i + 5], numbers[i + 7]];
    const left = Math.min(...xs), right = Math.max(...xs);
    const bottom = Math.min(...ys), top = Math.max(...ys);
    rects.push({ x: left, y: bottom, w: right - left, h: top - bottom });
  }
  if (!rects.length) return null;
  const color = entry(doc, dict, "C", lib);
  const note = entry(doc, dict, "Contents", lib);
  const text = entry(doc, dict, "Subj", lib);
  const said = entry(doc, dict, "CTMeaning", lib);
  return {
    id: nextId++,
    page: pageNumber,
    rects,
    text: text && typeof text.decodeText === "function" ? text.decodeText() : "",
    said: said && typeof said.decodeText === "function" ? said.decodeText() : "",
    color: color && color.asArray
      ? toHex(color.asArray().map((n) => doc.context.lookup(n)).map((n) => n.asNumber()))
      : el.color.value,
    note: note && typeof note.decodeText === "function" ? note.decodeText() : "",
  };
}

/* 開いたPDFから、前に引いた線を剥がして取り出す。
   剥がした方を「元のPDF」として持っておけば、保存のときは今ある線を足すだけで
   済む。pdf.js にも剥がした方を渡す（残すと、紙に描かれた線とこちらが重ねる線が
   二重に出る） */
async function takeMarksOut(bytes) {
  let lib;
  try {
    lib = await pdfLib();
    const doc = await lib.PDFDocument.load(bytes);
    const found = [];
    let removed = 0;
    for (const [index, page] of doc.getPages().entries()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      const kept = [];
      for (const ref of annots.asArray()) {
        const dict = doc.context.lookup(ref);
        if (!isMine(doc, dict, lib)) { kept.push(ref); continue; }
        const mark = annotToMark(doc, dict, index + 1, lib);
        if (mark) {
          removed += 1;
          found.push(mark);
          continue;
        }
        /* うちの印は付いているが、線として戻せなかった。
           **消さずに残す。** 消すと利用者の引いた線が黙って失われる。
           古い版のうちが書いていた付箋(Text)だけは、線の形を持たないうえに
           pdf.js が吹き出しの絵を紙の上に描いてしまうので、そこだけ落とす */
        const kind = entry(doc, dict, "Subtype", lib);
        if (kind && typeof kind.asString === "function" && kind.asString() === "/Text") {
          removed += 1;
          continue;
        }
        kept.push(ref);
      }
      if (kept.length !== annots.size()) {
        page.node.set(lib.PDFName.of("Annots"), doc.context.obj(kept));
      }
    }
    /* 剥がした物が1つでもあれば、剥がした方を渡す。
       線として戻せたかどうかで決めてはいけない（戻せない古い付箋が
       そのまま画面に出てしまう） */
    if (!removed) return { bare: bytes, found };
    return { bare: await doc.save(), found };
  } catch (err) {
    /* 読めない形でも、せめて開けるようにする。線は拾えないが見ることはできる */
    console.warn("前に引いた線を読めませんでした:", err);
    return { bare: bytes, found: [] };
  }
}

async function build() {
  const lib = await pdfLib();
  const doc = await lib.PDFDocument.load(originalBytes);
  for (const mark of marks) {
    const page = doc.getPage(mark.page - 1);
    page.node.addAnnot(doc.context.register(markToAnnot(doc, mark, lib)));
  }
  return doc.save();
}

async function save(quiet = false) {
  if (!originalBytes) return;
  try {
    const bytes = await build();
    if (saveHandle) {
      /* 開いたそのファイルに上書きする */
      const writable = await saveHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
    } else {
      /* Firefox の拡張機能は、ダウンロードの置き場より外へ直に書けない
         （絶対パスは断られる）。元のPDFと同じ場所へ上書きしたいときは、
         置き場の問いかけでそこへ入れてもらうしかない。
         勝手に保存する回（quiet）は聞かない。読んでいる間じゅう問いかけが
         出ることになるため */
      const settings = await loadSettings();
      const ask = !quiet && settings.pdfAskWhereToSave !== false;
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      await browser.downloads.download({
        url, filename: fileName || "marked.pdf", conflictAction: "overwrite", saveAs: ask,
      });
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    savedState = stamp();
    setDirty(false);
    if (!quiet) say("");
  } catch (err) {
    console.warn("保存できませんでした:", err);
    say(`Could not save: ${err && err.message ? err.message : err}`, true);
  }
}

el.save.addEventListener("click", () => save());

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    save();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "z") {
    /* 覚え書きを書いている間は、その欄の戻すをそのまま使わせる */
    if (el.editor.contains(event.target)) return;
    event.preventDefault();
    undo();
  }
  if (event.key === "Escape") {
    if (!el.editor.hidden) hideEditor();
    else if (!el.note.hidden) say("");   /* 知らせも Escape で消せる */
  }
});

/* 書いたものを捨てて閉じようとしたら引き止める */
window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

/* ------------------------------------------------------------------ *
 * 自動保存（設定画面で間隔を決める）
 * ------------------------------------------------------------------ */
async function applyAutoSave() {
  const settings = await loadSettings();
  const seconds = clampNum(settings.pdfAutoSave, 0, 3600, 0);
  clearInterval(autoTimer);
  autoTimer = null;
  if (!seconds) return;
  autoTimer = setInterval(() => {
    if (dirty && originalBytes) save(true);
  }, seconds * 1000);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.pdfAutoSave) applyAutoSave();
});
applyAutoSave();

/* ------------------------------------------------------------------ *
 * マーカーの色
 * ------------------------------------------------------------------ */
/* 前に使った色から始める。資料ごとに引き直す物ではないので、開くたびに
   選び直させると手間になる */
async function restoreColor() {
  try {
    const settings = await loadSettings();
    const color = String(settings.pdfMarkerColor || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(color)) el.color.value = color;
  } catch (err) {
    /* 覚えを読めなくても、色見本の既定の色で引ける */
    console.warn("マーカーの色を読めませんでした:", err);
  }
}

el.color.addEventListener("change", () => {
  browser.storage.local.set({ pdfMarkerColor: el.color.value }).catch((err) => {
    console.warn("マーカーの色を覚えられませんでした:", err);
  });
});

restoreColor();

/* ------------------------------------------------------------------ *
 * 入り口
 * ------------------------------------------------------------------ */
const wanted = new URLSearchParams(location.search).get("file");
if (wanted) openUrl(wanted);
else el.open.focus();
