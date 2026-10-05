"use strict";

/* 設定は「ページ側の吹き出し」「裏方（background）」「設定画面」「板」から
   読む。既定値がずれると、設定画面では自動になっているのにページでは動かない、
   といった噛み合わない状態になるので、ここ一枚に集めて全員が同じ物を見る */
const SETTINGS_DEFAULTS = {
  /* 訳す相手。gemini / deepl / google */
  engine: "gemini",
  /* 鍵はエンジンごとに別に持つ。行き来するたびに入れ直さずに済む。
     Gemini の鍵だけ名前が素っ気ないのは、エンジンが一つだった頃に
     入れてもらった鍵をそのまま使えるようにしているため */
  apiKey: "",
  deeplKey: "",
  googleKey: "",
  /* 本体アプリ（EnGoloyd）と同じ既定モデル。速さの割に訳が崩れない。
     Gemini のときだけ使う */
  model: "gemini-3.7-flash",
  /* auto: 選んだらすぐ訳す / button: 「訳す」を押したときだけ訳す。
     自動は手数が要らない代わりに、選び直すたびにAPIを叩く */
  trigger: "auto",
  /* カーソルを英単語に1秒あわせたら、その語の意味を出す。選ぶ手間が要らない
     代わりに、読んでいるだけで呼ぶことになるので、切れるようにしてある */
  hover: true,
  /* カーソルを合わせてから訳しに行くまでの間（ミリ秒）。短いと読んでいるだけで
     出てしまい、長いと待たされる。選んで訳す方は、選ぶという手間がもう掛かって
     いるので待たせない */
  hoverDelay: 1000,
  /* ハイライト翻訳＝選んで訳す方の札。名前は最初に置いたときのまま */
  enabled: true,
  /* 見た目。auto は端末の設定（OSの明暗）に従う */
  theme: "auto",
  accent: "blue",
  /* 吹き出しの見た目。色は「自分で決める」を入れたときだけ効く。切っていれば
     上の色味（accent）に従う */
  bubbleRadius: 7,
  bubbleBorder: 1,
  bubbleCustomColors: false,
  bubbleBg: "#D6DAF0",
  bubbleLine: "#B7C5D9",
  bubbleInk: "#000000",
  /* PDFに引いた線を、何秒ごとに勝手に保存するか。0 は自動で保存しない */
  pdfAutoSave: 0,
  bubbleFont: 13,
  bubbleWidth: 380,
  /* 単語を一語だけ選んだときに出る「EnGoloydで開く」の飛び先。既定は
     GitHub Pages に置いてある本体アプリ。自分で配る場所が違う人もいるので
     設定から差し替えられる */
  engoloydUrl: "https://gmgngnm.github.io/setsuguro/",
};

/* どのエンジンがどの鍵を使うか。設定画面・板・裏方で同じ対応を見るための表 */
const ENGINES_INFO = [
  { id: "gemini", label: "Gemini", keyField: "apiKey", inputId: "api-key" },
  { id: "deepl", label: "DeepL", keyField: "deeplKey", inputId: "deepl-key" },
  { id: "google", label: "Google翻訳", keyField: "googleKey", inputId: "google-key" },
];

/* 色味の選択肢。掲示板の配色に寄せた四色 */
const ACCENTS = [
  { id: "blue", label: "青" },
  { id: "orange", label: "橙" },
  { id: "green", label: "緑" },
  { id: "gray", label: "灰" },
];

const AUTO_SAVES = [
  { id: "0", label: "しない" },
  { id: "30", label: "30秒ごと" },
  { id: "60", label: "1分ごと" },
  { id: "300", label: "5分ごと" },
];

const THEMES = [
  { id: "auto", label: "自動（端末に合わせる）" },
  { id: "light", label: "明るい" },
  { id: "dark", label: "暗い" },
];

function fillSelect(select, items, value) {
  select.replaceChildren(
    ...items.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      return option;
    })
  );
  select.value = value;
}

/* 設定画面と板の見た目を、保存してある明暗と色味に合わせる */
function applyLook(settings) {
  const root = document.documentElement;
  root.dataset.theme = settings.theme || SETTINGS_DEFAULTS.theme;
  root.dataset.accent = settings.accent || SETTINGS_DEFAULTS.accent;
}

/* 待機時間はバーで決める。0 は「待たない」。上は5秒まであれば足りる */
const HOVER_DELAY_MIN = 0;
const HOVER_DELAY_MAX = 5000;
const HOVER_DELAY_STEP = 100;

function delayLabel(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "すぐ";
  return `${(value / 1000).toFixed(1)}秒`;
}

function fillDelayBar(bar, value) {
  bar.type = "range";
  bar.min = String(HOVER_DELAY_MIN);
  bar.max = String(HOVER_DELAY_MAX);
  bar.step = String(HOVER_DELAY_STEP);
  const saved = Number(value);
  bar.value = String(Number.isFinite(saved) ? Math.min(Math.max(saved, HOVER_DELAY_MIN), HOVER_DELAY_MAX) : SETTINGS_DEFAULTS.hoverDelay);
}

function fillEngineSelect(select, value) {
  select.replaceChildren(
    ...ENGINES_INFO.map((info) => {
      const option = document.createElement("option");
      option.value = info.id;
      option.textContent = info.label;
      return option;
    })
  );
  select.value = value;
}

function engineInfo(id) {
  return ENGINES_INFO.find((e) => e.id === id) || ENGINES_INFO[0];
}

async function loadSettings() {
  /* storage.local.get に既定値の入った物を渡すと、未保存の項目はその値で
     埋めて返ってくる */
  return browser.storage.local.get(SETTINGS_DEFAULTS);
}

/* いま読み込まれているのがどの版か、設定画面と板の見出しに出す。本体アプリの
   ビルド番号と同じ役目で、直したつもりが古いままだった、を見分けるためのもの */
function showVersion() {
  const el = document.getElementById("version");
  if (!el) return;
  const version = browser.runtime.getManifest?.().version;
  if (version) el.textContent = `v${version}`;
}

/* 設定から来た数を、決めた幅に収める。壊れた値でも止まらないように */
function clampNum(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}
