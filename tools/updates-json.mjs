#!/usr/bin/env node
/* 自前で配る版の更新情報（updates.json）を書く。
   Firefox は manifest の update_url をときどき見に行き、そこに自分より新しい
   版が載っていれば勝手に入れ替える。AMO に載せない（unlisted）物は、この
   ファイルを自分で用意しないと一生更新されない。

   使い方: node tools/updates-json.mjs <xpiのパス> <xpiを置くURL> <書き出す先>

   update_hash を入れておくと、取ってきた xpi が途中で化けていないかを
   Firefox が確かめてくれる。署名そのものとは別の、運び間違いへの備え */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [xpi, link, out] = process.argv.slice(2);
if (!xpi || !link || !out) {
  console.error("使い方: node tools/updates-json.mjs <xpi> <url> <out>");
  process.exit(2);
}
/* http だと Firefox が取りに行かない */
if (!link.startsWith("https://")) {
  console.error(`xpi の置き場は https でなければならない: ${link}`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const gecko = manifest.browser_specific_settings.gecko;
const hash = createHash("sha256").update(readFileSync(xpi)).digest("hex");

writeFileSync(out, JSON.stringify({
  addons: {
    [gecko.id]: {
      updates: [{
        version: manifest.version,
        update_link: link,
        update_hash: `sha256:${hash}`,
        browser_specific_settings: { gecko: { strict_min_version: gecko.strict_min_version } },
      }],
    },
  },
}, null, 2) + "\n");

console.log(`${out} を書いた（${gecko.id} v${manifest.version}）`);
