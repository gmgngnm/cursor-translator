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
                  "save", "state", "note", "viewerContainer", "editor", "text", "apply", "drop", "close"]) {
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

function say(message, bad = false) {
  el.note.textContent = message || "";
  el.note.classList.toggle("bad", Boolean(message) && bad);
}

function setDirty(value) {
  dirty = value;
  el.state.textContent = value ? "未保存の変更あり" : "";
  el.state.classList.toggle("dirty", value);
}

/* ------------------------------------------------------------------ *
 * 開く
 * ------------------------------------------------------------------ */
async function show(bytes, label, handle = null) {
  say("");
  fileName = label;
  picked = null;
  saveHandle = handle;
  hideEditor();
  setDirty(false);
  el.name.textContent = label;
  document.title = `${label} — Cursor Translator`;
  /* 前にこのPDFへ引いた線は、注釈として入っている。剥がしてこちらの持ち物に
     移すと、そのまま消したり覚え書きを書き直したりできる */
  const taken = await takeMarksOut(bytes);
  originalBytes = taken.bare;
  marks = taken.found;
  wantPage = await rememberedPage(label);
  if (taken.found.length) say(`前に引いた線を ${taken.found.length} 本読み込みました`);
  try {
    /* pdf.js は渡した配列を自分の物として使ってしまう（中身が空になる）。
       保存のときに元の姿が要るので、写しを渡す */
    const task = pdfjsLib.getDocument({ data: originalBytes.slice() });
    const doc = await task.promise;
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
  } catch (err) {
    console.warn("PDFを開けませんでした:", err);
    say(`開けませんでした: ${err && err.message ? err.message : err}`, true);
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
    say(`取りに行けませんでした: ${err && err.message ? err.message : err}`, true);
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
  const range = selection.getRangeAt(0);
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
  return [...made.entries()].map(([page, rects]) => ({
    id: nextId++, page, rects, color: el.color.value, note: "",
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
      /* 字の層より先に置く。後ろに置くと字を選べなくなる */
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
  if (!applyMarker()) say("先に、線を引きたいところを選んでください");
});

/* 選んでいるところに線を引く。引けたら true */
function applyMarker() {
  const made = marksFromSelection();
  if (!made.length) return false;
  marks.push(...made);
  /* 引いたら選択は解く。引いた線が選択の青に隠れて見えないため */
  window.getSelection().removeAllRanges();
  drawnAt = Date.now();
  drawMarks();
  setDirty(true);
  say("");
  return true;
}

/* 選んだところを右クリックしても引ける。釦まで手を動かさずに済む。
   紙の上で、かつ何か選んでいるときだけ横取りする。選んでいなければ
   いつもの右クリックの献立をそのまま出す */
document.addEventListener("contextmenu", (event) => {
  if (!el.viewerContainer.contains(event.target)) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  if (!applyMarker()) return;
  event.preventDefault();
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
  const rect = box.getBoundingClientRect();
  el.editor.hidden = false;
  el.editor.style.left = `${Math.min(rect.left, window.innerWidth - 250)}px`;
  el.editor.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 120)}px`;
  el.text.focus();
});

function hideEditor() {
  el.editor.hidden = true;
  picked = null;
}

el.apply.addEventListener("click", () => {
  if (!picked) return;
  picked.note = el.text.value.trim();
  hideEditor();
  drawMarks();
  setDirty(true);
});
el.drop.addEventListener("click", () => {
  if (!picked) return;
  marks = marks.filter((m) => m.id !== picked.id);
  hideEditor();
  drawMarks();
  setDirty(true);
});
el.close.addEventListener("click", hideEditor);

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
     文字が透けるよう、乗算で薄く重ねる */
  const ops = ["/GS gs", `${r} ${g} ${b} rg`,
    ...mark.rects.map((c) => `${c.x} ${c.y} ${c.w} ${c.h} re f`)].join("\n");
  const contents = typedArrayFor(ops);
  const form = PDFRawStream.of(doc.context.obj({
    Type: "XObject", Subtype: "Form", FormType: 1,
    BBox: [x0, y0, x1, y1],
    Resources: { ExtGState: { GS: { Type: "ExtGState", ca: 0.4, BM: "Multiply" } } },
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
    AP: { N: doc.context.register(form) },
  });
}

/* うちが付けた注釈かどうか。他の道具が付けた注釈には触らない */
function isMine(dict, lib) {
  const title = dict && dict.get && dict.get(lib.PDFName.of("T"));
  return Boolean(title && typeof title.decodeText === "function" && title.decodeText() === MINE);
}

function annotToMark(dict, pageNumber, lib) {
  const quad = dict.get(lib.PDFName.of("QuadPoints"));
  if (!quad || !quad.asArray) return null;
  const numbers = quad.asArray().map((n) => n.asNumber());
  const rects = [];
  for (let i = 0; i + 7 < numbers.length; i += 8) {
    const xs = [numbers[i], numbers[i + 2], numbers[i + 4], numbers[i + 6]];
    const ys = [numbers[i + 1], numbers[i + 3], numbers[i + 5], numbers[i + 7]];
    const left = Math.min(...xs), right = Math.max(...xs);
    const bottom = Math.min(...ys), top = Math.max(...ys);
    rects.push({ x: left, y: bottom, w: right - left, h: top - bottom });
  }
  if (!rects.length) return null;
  const color = dict.get(lib.PDFName.of("C"));
  const note = dict.get(lib.PDFName.of("Contents"));
  return {
    id: nextId++,
    page: pageNumber,
    rects,
    color: color && color.asArray ? toHex(color.asArray().map((n) => n.asNumber())) : el.color.value,
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
        if (!isMine(dict, lib)) { kept.push(ref); continue; }
        removed += 1;
        /* 古い版のうちが書いていた付箋(Text)には、線の形が入っていない。
           線として戻せないので、そのまま落とす（残すと pdf.js が吹き出しの
           絵を紙の上に描いてしまう） */
        const mark = annotToMark(dict, index + 1, lib);
        if (mark) found.push(mark);
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
    setDirty(false);
    if (!quiet) say("");
  } catch (err) {
    console.warn("保存できませんでした:", err);
    say(`保存できませんでした: ${err && err.message ? err.message : err}`, true);
  }
}

el.save.addEventListener("click", () => save());

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "s") {
    event.preventDefault();
    save();
  }
  if (event.key === "Escape" && !el.editor.hidden) hideEditor();
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
