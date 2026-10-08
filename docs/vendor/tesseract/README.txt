Self-hosted copies of the free, open-source tools the "Split a bill by items"
sheet uses to read a receipt photo ON THE PHONE (nothing is uploaded anywhere).
Stored here, like vendor/pdfjs, so the app does not depend on an outside site.

  tesseract.min.js, worker.min.js        tesseract.js 7.0.0   (Apache-2.0)  https://github.com/naptha/tesseract.js
  tesseract-core-lstm.wasm.js            tesseract.js-core 7.0.0 (Apache-2.0) the OCR engine, plain build
  tesseract-core-simd-lstm.wasm.js       tesseract.js-core 7.0.0 (Apache-2.0) same engine, faster build (used when the phone supports it)
  tesseract-core-relaxedsimd-lstm.wasm.js tesseract.js-core 7.0.0 (Apache-2.0) fastest build (newest phones/browsers)
  spa.traineddata.gz                     Spanish language data, "tessdata_fast" (Apache-2.0),
                                         https://github.com/tesseract-ocr/tessdata_fast  (gzip of spa.traineddata)

To update: `npm pack tesseract.js tesseract.js-core`, copy dist/tesseract.min.js and
dist/worker.min.js plus the three tesseract-core*-lstm.wasm.js files (tesseract.js and tesseract.js-core must be the SAME major version), and re-gzip the
language file. Licences: LICENSE-tesseract.js.md, LICENSE-tesseract.js-core.
