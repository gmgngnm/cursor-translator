# Cursor Translator の作業メモ

ページの英文を選ぶ、または英単語にカーソルを合わせると、その場に日本語訳を出す
Firefox アドオン。ビルド手順もパッケージも無く、`manifest.json` を Firefox に
そのまま読ませる。

もとは [setsuguro](https://github.com/gmgngnm/setsuguro)（EnGoloyd）の
`firefox-addon/` に間借りしていた。2026-10-05 にここへ移した。

## 直しながら試す

```
npx web-ext run
```

保存するたびに読み込み直すので、`about:debugging` を触らなくてよい。

直したら `manifest.json` の `version` を上げる。画面にビルド番号のような表示は
無いので、`about:debugging` で読み込み直したものかどうかは設定画面と板の見出しに
出る版で見分ける。

## 確認のしかた

テストは Playwright で、実際に画面を動かして確かめる。作業用のファイルは
リポジトリに入れず、スクラッチ領域に置く。

- Playwright: `NODE_PATH=/opt/node22/lib/node_modules`
- Chromium: `executablePath: "/opt/pw-browsers/chromium"`
- 配信: リポジトリ直下で `python3 -m http.server 8941`
  （`setsid nohup ... </dev/null &` で起こすこと）
- `browser.*` は Chromium に差し込んだ偽物。訳す相手は `page.route` で差し替える。
  実際には呼ばない
- Firefox の内蔵PDFビューアは `resource://` のページで、拡張機能は差し込めない
  （Firefox 本体の PdfStreamConverter.sys.mjs で確認済み）。そのため pdf.js を
  同梱した自前のビューアを `pdf/` に持っている。テストは本物のPDFをその自前
  ビューアに描かせて確かめる

見た目を変えたときは、明るいテーマと暗いテーマの両方を撮って確かめる。
時間や見え方の主張は、測らずに書かないこと。

「直した」と言う前に、**変更前のコードで実際に症状が出ることを確かめる**。
出ないなら、それは直した対象ではない。

`web-ext lint` は `pdf/vendor/` に警告を出す（同梱した pdf.js のもの）。
自分の分だけ見るときは `--ignore-files "pdf/vendor/**"` を付ける。

## EnGoloyd との繋ぎ目

英単語を一語だけ選んだとき `index.html?w=単語` で EnGoloyd（PWA 本体）を開く。
それを受ける口は向こうの `app.js` の `startDecomposeFromQuery`。こちら側の
飛び先は `common.js` の `SETTINGS_DEFAULTS.engoloydUrl`。繋ぎ目はここだけなので、
消すならあちらの受け口も一緒に外すこと。

## マージ

**テストが通ったら、確認を取らずにそのままマージしてよい**（2026-09-15 に利用者が
指示）。スカッシュマージで、コミット名は `タイトル (#番号)` の形に揃える。

マージしたあとに続きの作業をする場合は、枝を main から引き直すこと。
スカッシュマージ後は同じ変更が main 側と枝側に別のコミットとして残り、
そのまま続けると必ず衝突する。

```
git fetch origin main && git checkout -B <枝> origin/main
```

## 書き方

- 画面に出る文言・コミット・PRの説明は日本語
- コメントは「なぜそう書いたか」を書く。何をしているかはコードが語る
- 既存のコメントの密度と語り口に合わせる
