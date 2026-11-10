// The camera scanner reads barcodes with a small WebAssembly decoder (zxing). Serve it from this
// app instead of a public CDN: the app works offline and sends nothing anywhere.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("public/vendor", { recursive: true });
copyFileSync("node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", "public/vendor/zxing_reader.wasm");
