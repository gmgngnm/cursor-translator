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
});
linkService.setViewer(viewer);

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = "page-width";
  showScale();
  fillPages();
  drawMarks();
});
eventBus.on("scalechanging", () => { showScale(); drawMarks(); });
eventBus.on("pagechanging", () => { el.page.value = String(viewer.currentPageNumber); });
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

function say(message) {
  el.note.textContent = message || "";
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
  originalBytes = bytes;
  fileName = label;
  marks = [];
  picked = null;
  saveHandle = handle;
  hideEditor();
  setDirty(false);
  el.name.textContent = label;
  document.title = `${label} — Cursor Translator`;
  try {
    /* pdf.js は渡した配列を自分の物として使ってしまう（中身が空になる）。
       保存のときに元の姿が要るので、写しを渡す */
    const task = pdfjsLib.getDocument({ data: bytes.slice() });
    const doc = await task.promise;
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
  } catch (err) {
    console.warn("PDFを開けませんでした:", err);
    say(`開けませんでした: ${err && err.message ? err.message : err}`);
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
    say(`取りに行けませんでした: ${err && err.message ? err.message : err}`);
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
  const made = marksFromSelection();
  if (!made.length) {
    say("先に、線を引きたいところを選んでください");
    return;
  }
  marks.push(...made);
  /* 引いたら選択は解く。引いた線が選択の青に隠れて見えないため */
  window.getSelection().removeAllRanges();
  drawnAt = Date.now();
  drawMarks();
  setDirty(true);
  say("");
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
 * 保存
 * ------------------------------------------------------------------ */
function hex(color) {
  const n = parseInt((color || "#ffe066").slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

async function build() {
  const { PDFDocument, rgb, PDFHexString } = await import("./vendor/pdf-lib.esm.min.js");
  const doc = await PDFDocument.load(originalBytes);
  for (const mark of marks) {
    const page = doc.getPage(mark.page - 1);
    const [r, g, b] = hex(mark.color);
    for (const rect of mark.rects) {
      /* 線そのものは中身として描く。注釈だけに頼ると、見る道具によっては
         何も出ない（見た目を持たない注釈を描けない物がある） */
      page.drawRectangle({
        x: rect.x, y: rect.y, width: rect.w, height: rect.h,
        color: rgb(r, g, b), opacity: 0.4, borderWidth: 0,
      });
    }
    if (!mark.note) continue;
    /* 覚え書きは付箋の注釈として残す。他のPDFの道具でも読める形。
       日本語が入るので、文字はUTF-16で書く（PDFString だと化ける） */
    const first = mark.rects[0];
    const annot = doc.context.obj({
      Type: "Annot", Subtype: "Text", Name: "Comment",
      Rect: [first.x, first.y + first.h - 18, first.x + 18, first.y + first.h],
      Contents: PDFHexString.fromText(mark.note),
      T: PDFHexString.fromText("Cursor Translator"),
      C: [r, g, b],
      F: 4,
    });
    page.node.addAnnot(doc.context.register(annot));
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
      /* その仕組みが無いブラウザでは、同じ名前でダウンロードの置き場へ
         上書きする。拡張機能はそこより外へは書けない */
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      await browser.downloads.download({
        url, filename: fileName || "marked.pdf", conflictAction: "overwrite", saveAs: false,
      });
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    setDirty(false);
    if (!quiet) say("");
  } catch (err) {
    console.warn("保存できませんでした:", err);
    say(`保存できませんでした: ${err && err.message ? err.message : err}`);
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
 * 入り口
 * ------------------------------------------------------------------ */
const wanted = new URLSearchParams(location.search).get("file");
if (wanted) openUrl(wanted);
else el.open.focus();
