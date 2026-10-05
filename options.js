"use strict";

const el = {
  enabled: document.getElementById("enabled"),
  hover: document.getElementById("hover"),
  delay: document.getElementById("hover-delay"),
  delayLabel: document.getElementById("hover-delay-label"),
  trigger: document.getElementById("trigger"),
  engine: document.getElementById("engine"),
  model: document.getElementById("model"),
  modelList: document.getElementById("model-list"),
  radius: document.getElementById("bubble-radius"),
  radiusLabel: document.getElementById("bubble-radius-label"),
  border: document.getElementById("bubble-border"),
  borderLabel: document.getElementById("bubble-border-label"),
  font: document.getElementById("bubble-font"),
  fontLabel: document.getElementById("bubble-font-label"),
  width: document.getElementById("bubble-width"),
  widthLabel: document.getElementById("bubble-width-label"),
  custom: document.getElementById("bubble-custom"),
  bg: document.getElementById("bubble-bg"),
  line: document.getElementById("bubble-line"),
  inkColor: document.getElementById("bubble-ink"),
  preview: document.getElementById("bubble-preview"),
  autosave: document.getElementById("autosave"),
  theme: document.getElementById("theme"),
  accent: document.getElementById("accent"),
  status: document.getElementById("status"),
};

/* 鍵の欄は相手の数だけある。どれも同じ扱いなので表で回す */
const keyInputs = ENGINES_INFO.map((info) => ({ info, input: document.getElementById(info.inputId) }));

let statusTimer = null;
function say(text) {
  el.status.textContent = text;
  el.status.classList.add("on");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.status.classList.remove("on"), 1600);
}

/* 保存釦は置かない。押し忘れで動かない事故の方が多いため。打っている最中に
   毎打鍵書きに行かないよう、手が止まってからまとめて保存する。
   待っている分は溜めてから一度に書く。時計を一つで使い回して上書きすると、
   鍵を打った直後に相手を選び替えたときに、打った鍵ごと消える */
let saveTimer = null;
let pending = {};
function saveSoon(values, delay = 400) {
  Object.assign(pending, values);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, delay);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!Object.keys(pending).length) return;
  const values = pending;
  pending = {};
  await browser.storage.local.set(values);
  say("保存しました");
}

/* 決め方をそのまま見本に当てる。吹き出しは読んでいるページの上にしか出ない
   ので、ここで確かめられないと決めようがない */
function drawPreview() {
  const style = el.preview.style;
  style.borderRadius = `${el.radius.value}px`;
  style.borderWidth = `${el.border.value}px`;
  style.fontSize = `${el.font.value}px`;
  style.maxWidth = `${el.width.value}px`;
  if (el.custom.checked) {
    style.background = el.bg.value;
    style.borderColor = el.line.value;
    style.color = el.inkColor.value;
  } else {
    style.background = "";
    style.borderColor = "";
    style.color = "";
  }
  el.radiusLabel.textContent = `${el.radius.value}px`;
  el.borderLabel.textContent = `${el.border.value}px`;
  el.fontLabel.textContent = `${el.font.value}px`;
  el.widthLabel.textContent = `${el.width.value}px`;
  for (const row of document.querySelectorAll("[data-custom]")) row.hidden = !el.custom.checked;
}

/* 選んでいる相手の行だけ出す。使わない鍵の欄まで並ぶと、どれに入れればよいか
   分からなくなる */
function showEngineRows(engine) {
  for (const row of document.querySelectorAll("[data-engine]")) {
    row.hidden = row.dataset.engine !== engine;
  }
}

async function fillModelList() {
  const res = await browser.runtime.sendMessage({ type: "models" });
  if (!res || !res.ok || !res.models.length) return;
  el.modelList.replaceChildren(
    ...res.models.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      return option;
    })
  );
}

async function init() {
  showVersion();
  const settings = await loadSettings();
  for (const { info, input } of keyInputs) input.value = settings[info.keyField];
  el.enabled.checked = settings.enabled;
  el.hover.checked = settings.hover;
  fillDelayBar(el.delay, settings.hoverDelay);
  el.delayLabel.textContent = delayLabel(el.delay.value);
  fillEngineSelect(el.engine, settings.engine);
  el.trigger.value = settings.trigger;
  el.model.value = settings.model;
  el.radius.value = String(clampNum(settings.bubbleRadius, 0, 20, SETTINGS_DEFAULTS.bubbleRadius));
  el.border.value = String(clampNum(settings.bubbleBorder, 0, 5, SETTINGS_DEFAULTS.bubbleBorder));
  el.font.value = String(clampNum(settings.bubbleFont, 10, 24, SETTINGS_DEFAULTS.bubbleFont));
  el.width.value = String(clampNum(settings.bubbleWidth, 160, 800, SETTINGS_DEFAULTS.bubbleWidth));
  el.custom.checked = Boolean(settings.bubbleCustomColors);
  el.bg.value = settings.bubbleBg;
  el.line.value = settings.bubbleLine;
  el.inkColor.value = settings.bubbleInk;
  drawPreview();
  fillSelect(el.autosave, AUTO_SAVES, String(clampNum(settings.pdfAutoSave, 0, 3600, 0)));
  fillSelect(el.theme, THEMES, settings.theme);
  fillSelect(el.accent, ACCENTS, settings.accent);
  applyLook(settings);
  showEngineRows(settings.engine);
  if (settings.apiKey) fillModelList();
}

for (const { info, input } of keyInputs) {
  input.addEventListener("input", () => {
    saveSoon({ [info.keyField]: input.value.trim() });
  });
}

/* Gemini の鍵を入れ終えた頃に、そのキーで使えるモデルを候補へ */
const geminiInput = keyInputs.find((k) => k.info.id === "gemini").input;
geminiInput.addEventListener("change", () => {
  setTimeout(fillModelList, 500);
});

for (const button of document.querySelectorAll(".peek")) {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.for);
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    button.textContent = hidden ? "隠す" : "表示";
  });
}

el.engine.addEventListener("change", () => {
  showEngineRows(el.engine.value);
  saveSoon({ engine: el.engine.value }, 0);
});

el.autosave.addEventListener("change", () => saveSoon({ pdfAutoSave: Number(el.autosave.value) }, 0));
el.enabled.addEventListener("change", () => saveSoon({ enabled: el.enabled.checked }, 0));
el.hover.addEventListener("change", () => saveSoon({ hover: el.hover.checked }, 0));
/* つまみを動かしている間は数字だけ追わせ、離したところで保存する */
el.delay.addEventListener("input", () => {
  el.delayLabel.textContent = delayLabel(el.delay.value);
});
el.delay.addEventListener("change", () => saveSoon({ hoverDelay: Number(el.delay.value) }, 0));
el.trigger.addEventListener("change", () => saveSoon({ trigger: el.trigger.value }, 0));

el.model.addEventListener("input", () => {
  /* 空のまま保存すると訳せなくなるので、その時は既定へ戻す */
  saveSoon({ model: el.model.value.trim() || SETTINGS_DEFAULTS.model });
});

for (const [input, key] of [
  [el.radius, "bubbleRadius"], [el.border, "bubbleBorder"],
  [el.font, "bubbleFont"], [el.width, "bubbleWidth"],
]) {
  input.addEventListener("input", drawPreview);
  input.addEventListener("change", () => saveSoon({ [key]: Number(input.value) }, 0));
}

el.custom.addEventListener("change", () => {
  drawPreview();
  saveSoon({ bubbleCustomColors: el.custom.checked }, 0);
});

for (const [input, key] of [[el.bg, "bubbleBg"], [el.line, "bubbleLine"], [el.inkColor, "bubbleInk"]]) {
  input.addEventListener("input", () => {
    drawPreview();
    saveSoon({ [key]: input.value });
  });
}

/* 見た目は選んだ場で確かめられた方がよいので、保存を待たずに当てる */
el.theme.addEventListener("change", () => {
  applyLook({ theme: el.theme.value, accent: el.accent.value });
  drawPreview();
  saveSoon({ theme: el.theme.value }, 0);
});

el.accent.addEventListener("change", () => {
  applyLook({ theme: el.theme.value, accent: el.accent.value });
  drawPreview();
  saveSoon({ accent: el.accent.value }, 0);
});

init();
