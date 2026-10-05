pdf.js 4.10.38 の legacy ビルドを dist からそのまま置いたもの。中身は触らない。

なぜ legacy の 4.x かというと、5.x と 6.x は Map.prototype.getOrInsertComputed
（2025年に入ったばかりの仕組み）を使っていて、少し古いブラウザでは動かないため。

入れ替えるときは npm pack pdfjs-dist@4 で取って、legacy/build/pdf.min.mjs,
legacy/build/pdf.worker.min.mjs, legacy/web/pdf_viewer.mjs, web/pdf_viewer.css を
上書きする。

pdf-lib 1.17.1（dist/pdf-lib.esm.min.js）も同じく dist からそのまま。
マーカーと注釈を書き込んで保存するのに使う。pdf.js は読むだけで書けない。
入れ替えるときは npm pack pdf-lib で取って上書きする。
