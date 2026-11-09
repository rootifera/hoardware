// Code 128 (subset B: printable ASCII 32-126), the barcode every scanner reads. Item codes
// such as "HW-000123" are letters, digits and a hyphen, so subset B covers them.

// Bar/space widths (in modules) of each symbol value 0..106; the stop symbol has 7 elements.
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];
const START_B = 104;
const STOP = 106;

/** Can this text be a Code 128 barcode (subset B)? */
export function canEncode(text: string): boolean {
  return text.length > 0 && /^[\x20-\x7e]+$/.test(text);
}

/** The symbol values of the barcode: start, the data, the check symbol, the stop. */
export function symbols(text: string): number[] {
  if (!canEncode(text)) throw new Error("Code 128 subset B encodes printable ASCII only");
  const data = [...text].map((c) => c.charCodeAt(0) - 32);
  const check = (START_B + data.reduce((sum, value, i) => sum + value * (i + 1), 0)) % 103;
  return [START_B, ...data, check, STOP];
}

/** The widths of alternating bars and spaces (starting with a bar), in modules. */
export function elements(text: string): number[] {
  return symbols(text).flatMap((s) => [...PATTERNS[s]].map(Number));
}

/** The bars as [start, width] pairs in modules, and the total width (without quiet zones). */
export function bars(text: string): { bars: [number, number][]; modules: number } {
  const out: [number, number][] = [];
  let x = 0;
  elements(text).forEach((width, i) => {
    if (i % 2 === 0) out.push([x, width]);
    x += width;
  });
  return { bars: out, modules: x };
}
