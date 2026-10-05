"use strict";

/* ツールバーの釦を押すと出る板。読んでいるページを離れずに入切と出すまでの間を
   変えるのが役目。APIキーのような長い物は入れず、歯車から設定画面へ渡す */

const el = {
  gear: document.getElementById("gear"),
  enabled: document.getElementById("enabled"),
  hover: document.getElementById("hover"),
  delay: document.getElementById("hover-delay"),
  delayLabel: document.getElementById("hover-delay-label"),
  engine: document.getElementById("engine"),
  note: document.getElementById("key-note"),
  pdf: document.getElementById("pdf"),
};

let settings = { ...SETTINGS_DEFAULTS };

/* 鍵を入れる欄はここに無いので、無いことだけは伝えて設定画面へ送る */
function showKeyState() {
  const info = engineInfo(el.engine.value);
  const has = String(settings[info.keyField] || "").trim();
  el.note.textContent = has ? "" : `${info.label} のAPIキーが未設定。歯車から入れてください`;
  el.note.classList.toggle("bad", !has);
}

/* いま見ているページがPDFなら、それを自前のビューアで開き直す。Firefox の
   内蔵ビューアは resource:// のページで、そこには差し込めないため */
function isPdfUrl(url) {
  return /^https?:\/\/|^file:\/\//.test(url || "") && /\.pdf(\?|#|$)/i.test(url || "");
}

async function currentTab() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function init() {
  showVersion();
  settings = await loadSettings();
  applyLook(settings);
  el.enabled.checked = settings.enabled;
  el.hover.checked = settings.hover;
  fillDelayBar(el.delay, settings.hoverDelay);
  el.delayLabel.textContent = delayLabel(el.delay.value);
  fillEngineSelect(el.engine, settings.engine);
  showKeyState();

  const tab = await currentTab();
  if (tab && isPdfUrl(tab.url)) {
    el.pdf.textContent = "このPDFをここで開く";
    el.pdf.dataset.url = tab.url;
  }
}

el.enabled.addEventListener("change", () => {
  browser.storage.local.set({ enabled: el.enabled.checked });
});

el.hover.addEventListener("change", () => {
  browser.storage.local.set({ hover: el.hover.checked });
});

/* つまみを動かしている間は数字だけ追わせ、離したところで保存する */
el.delay.addEventListener("input", () => {
  el.delayLabel.textContent = delayLabel(el.delay.value);
});

el.delay.addEventListener("change", () => {
  browser.storage.local.set({ hoverDelay: Number(el.delay.value) });
});

el.engine.addEventListener("change", () => {
  settings.engine = el.engine.value;
  browser.storage.local.set({ engine: el.engine.value });
  showKeyState();
});

el.pdf.addEventListener("click", async () => {
  const url = el.pdf.dataset.url;
  const page = url ? `pdf/viewer.html?file=${encodeURIComponent(url)}` : "pdf/viewer.html";
  await browser.tabs.create({ url: browser.runtime.getURL(page) });
  window.close();
});

el.gear.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

init();
