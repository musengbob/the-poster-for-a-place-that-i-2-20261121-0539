// The Poster for a Place That Isn't There
// main.ts — draws one invented travel poster to /output/entry.png.
// Pure Node stdlib (no network, no dependencies): a tiny raster canvas,
// a 5x7 bitmap font, and a hand-rolled PNG encoder. Fully deterministic.
// Place: THALVARA — The Lighthouse Isles. Golden dusk, a sea of clouds,
// one tall lighthouse on a floating rock isle, light sweeping the sky.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1024, H = 1024;
const OUT = process.env.MAKEFUN_OUTPUT_DIR || "/output";

// ------------------------------------------------------------------ RNG (seeded)
let seed = 0x7a1a4a & 0xffffffff;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

// ------------------------------------------------------------------ canvas
type RGB = [number, number, number];
const buf = new Uint8Array(W * H * 3);
function setP(x: number, y: number, c: RGB, a = 1): void {
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const i = (yi * W + xi) * 3;
  if (a >= 1) { buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; }
  else { buf[i] = buf[i] + (c[0] - buf[i]) * a; buf[i + 1] = buf[i + 1] + (c[1] - buf[i + 1]) * a; buf[i + 2] = buf[i + 2] + (c[2] - buf[i + 2]) * a; }
}
function rect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
  for (let j = Math.floor(y); j < y + h; j++) for (let i = Math.floor(x); i < x + w; i++) setP(i, j, c, a);
}
function hline(x0: number, x1: number, y: number, c: RGB, a = 1): void {
  for (let i = Math.floor(x0); i <= x1; i++) setP(i, y, c, a);
}
function circle(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    const dy = y - cy, dx = Math.sqrt(Math.max(0, r * r - dy * dy));
    for (let x = Math.floor(cx - dx); x <= cx + dx; x++) setP(x, y, c, a);
  }
}
function ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
    const dy = (y - cy) / ry, dx = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    for (let x = Math.floor(cx - dx); x <= cx + dx; x++) setP(x, y, c, a);
  }
}
// Filled polygon via scanline.
function poly(pts: [number, number][], c: RGB, a = 1): void {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const [x1, y1p] = pts[k], [x2, y2p] = pts[(k + 1) % pts.length];
      if ((y1p <= y && y2p > y) || (y2p <= y && y1p > y)) {
        xs.push(x1 + ((y - y1p) / (y2p - y1p)) * (x2 - x1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) hline(xs[k], xs[k + 1], y, c, a);
  }
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
// Vertical gradient band.
function vgrad(y0: number, y1: number, top: RGB, bot: RGB): void {
  for (let y = Math.floor(y0); y < y1; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    const c = mix(top, bot, t);
    for (let x = 0; x < W; x++) setP(x, y, c);
  }
}

// ------------------------------------------------------------------ PNG out
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); }
  return t;
})();
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a; if (pb <= pc) return b; return c;
}
function encodePNG(w: number, h: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 3, raw = Buffer.alloc(h * (stride + 1)), prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride);
    let best: Buffer | null = null, bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      const filtered = Buffer.alloc(stride);
      for (let x = 0; x < stride; x++) {
        const v = row[x], a = x >= 3 ? row[x - 3] : 0, b = prev[x], cc = x >= 3 ? prev[x - 3] : 0;
        let p = v; if (f === 1) p = v - a; else if (f === 2) p = v - b; else if (f === 3) p = v - ((a + b) >> 1); else if (f === 4) p = v - paeth(a, b, cc);
        filtered[x] = p & 0xff;
      }
      let score = 0; for (let x = 0; x < stride; x++) score += Math.abs((filtered[x] << 24) >> 24);
      if (score < bestScore) { bestScore = score; best = filtered; raw[y * (stride + 1)] = f; filtered.copy(raw, y * (stride + 1) + 1); }
    }
    row.copy(prev);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ 5x7 font
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
  "(": ["00010", "00100", "01000", "01000", "01000", "00100", "00010"],
  ")": ["01000", "00100", "00010", "00010", "00010", "00100", "01000"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "<": ["00010", "00100", "01000", "10000", "01000", "00100", "00010"],
  ">": ["01000", "00100", "00010", "00001", "00010", "00100", "01000"],
  "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  '"': ["01010", "01010", "00000", "00000", "00000", "00000", "00000"],
  "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
  "*": ["00000", "00100", "10101", "01110", "10101", "00100", "00000"],
  ";": ["00000", "01100", "01100", "00000", "01100", "00100", "01000"],
};
function textWidth(s: string, scale: number): number {
  return s.length * 6 * scale - scale;
}
function drawGlyph(ch: string, x: number, y: number, scale: number, c: RGB, a = 1): void {
  const g = FONT[ch] || FONT["?"];
  for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++)
    if (g[r][col] === "1") rect(x + col * scale, y + r * scale, scale, scale, c, a);
}
function drawText(s: string, x: number, y: number, scale: number, c: RGB, a = 1): void {
  let cx = x;
  for (const ch of s) { drawGlyph(ch, cx, y, scale, c, a); cx += 6 * scale; }
}
function drawTextC(s: string, cx: number, y: number, scale: number, c: RGB, a = 1): void {
  drawText(s, cx - textWidth(s, scale) / 2, y, scale, c, a);
}

// ------------------------------------------------------------------ palette
const CREAM: RGB = [250, 240, 214];
const CREAM_DIM: RGB = [232, 214, 178];
const INK: RGB = [24, 30, 52];
const SKY_TOP: RGB = [26, 38, 74];
const SKY_MID: RGB = [52, 96, 110];
const SKY_LOW: RGB = [214, 138, 74];
const SUN: RGB = [255, 214, 140];
const SUN_CORE: RGB = [255, 238, 196];
const CLOUD_LIT: RGB = [255, 226, 188];
const CLOUD_MID: RGB = [238, 190, 150];
const CLOUD_SH: RGB = [150, 108, 130];
const ROCK_TOP: RGB = [96, 74, 62];
const ROCK: RGB = [62, 46, 44];
const ROCK_DARK: RGB = [38, 28, 32];
const GRASS: RGB = [122, 140, 74];
const GRASS_LIT: RGB = [178, 164, 96];
const TOWER: RGB = [246, 238, 222];
const TOWER_BAND: RGB = [178, 58, 44];
const LAMP: RGB = [255, 196, 90];

// ------------------------------------------------------------------ sky
vgrad(0, 420, SKY_TOP, SKY_MID);
vgrad(420, 700, SKY_MID, SKY_LOW);
// stars in the upper sky
for (let i = 0; i < 90; i++) {
  const x = rnd() * W, y = rnd() * 260, r = rnd();
  setP(x, y, CREAM, 0.25 + r * 0.5);
  if (r > 0.85) { setP(x + 1, y, CREAM, 0.4); setP(x, y + 1, CREAM, 0.4); }
}
// sun glow + disc (low, right of centre, clear of the beam)
const SX = 720, SY = 575;
for (let r = 220; r > 0; r -= 4) {
  const a = 0.05 * (1 - r / 220);
  circle(SX, SY, r, SUN, Math.max(0.012, a));
}
circle(SX, SY, 70, SUN, 0.95);
circle(SX, SY, 58, SUN_CORE, 1);
// sun reflection shimmer on the cloud sea
for (let i = 0; i < 26; i++) {
  const x = SX + (rnd() - 0.5) * 260, y = 640 + rnd() * 90;
  ellipse(x, y, 14 + rnd() * 30, 2.5 + rnd() * 2, SUN, 0.16 + rnd() * 0.2);
}

// ------------------------------------------------------------------ birds
function bird(x: number, y: number, s: number, c: RGB, a: number): void {
  poly([[x - s, y], [x - s * 0.45, y - s * 0.45], [x, y], [x + s * 0.45, y - s * 0.45], [x + s, y]], c, a);
}
bird(210, 250, 16, INK, 0.75); bird(268, 218, 12, INK, 0.7); bird(320, 268, 10, INK, 0.65);
bird(800, 210, 14, INK, 0.7); bird(856, 248, 10, INK, 0.65); bird(150, 330, 9, INK, 0.6);

// ------------------------------------------------------------------ cloud sea
function cloudBand(y: number, h: number, lit: RGB, mid: RGB, sh: RGB, n: number, spread: number): void {
  // soft horizontal band of overlapping puffs
  for (let i = 0; i < n; i++) {
    const x = rnd() * W, r = 40 + rnd() * spread;
    ellipse(x, y + (rnd() - 0.5) * h * 0.5, r, r * 0.42, mid, 0.9);
  }
  for (let i = 0; i < n; i++) {
    const x = rnd() * W, r = 30 + rnd() * spread * 0.7;
    ellipse(x, y - h * 0.18 + (rnd() - 0.5) * 8, r, r * 0.36, lit, 0.95);
  }
  for (let i = 0; i < n; i++) {
    const x = rnd() * W, r = 34 + rnd() * spread * 0.6;
    ellipse(x, y + h * 0.32, r, r * 0.34, sh, 0.55);
  }
}
cloudBand(660, 70, CLOUD_LIT, CLOUD_MID, CLOUD_SH, 26, 90);
cloudBand(760, 90, CLOUD_LIT, CLOUD_MID, CLOUD_SH, 30, 110);
cloudBand(880, 110, CLOUD_LIT, CLOUD_MID, CLOUD_SH, 34, 130);
cloudBand(980, 90, CLOUD_MID, CLOUD_SH, CLOUD_SH, 30, 120);

// ------------------------------------------------------------------ floating isles
function isle(cx: number, topY: number, w: number, depth: number, grassC: RGB): void {
  // flat grassy top, rocky tapered underside with hanging roots
  ellipse(cx, topY, w / 2, 16, grassC, 1);
  rect(cx - w / 2, topY - 4, w, 10, grassC, 1);
  poly([[cx - w / 2 + 6, topY + 4], [cx + w / 2 - 6, topY + 4], [cx + w * 0.18, topY + depth], [cx - w * 0.18, topY + depth]], ROCK, 1);
  poly([[cx - w * 0.30, topY + 30], [cx + w * 0.26, topY + 26], [cx + w * 0.12, topY + depth - 8], [cx - w * 0.16, topY + depth - 6]], ROCK_DARK, 0.85);
  // warm rim light on the top edge
  hline(cx - w / 2 + 8, cx + w / 2 - 8, topY - 8, GRASS_LIT, 0.9);
  // hanging vines
  for (let i = 0; i < 5; i++) {
    const vx = cx - w / 2 + 20 + rnd() * (w - 40), vl = 14 + rnd() * 26;
    for (let y = 0; y < vl; y++) setP(vx + Math.sin(y * 0.3 + i) * 2, topY + 8 + y, GRASS, 0.85);
  }
}
isle(512, 700, 470, 150, GRASS);          // main isle
isle(180, 800, 210, 90, GRASS);           // left islet
isle(850, 820, 190, 80, GRASS);           // right islet

// tiny trees on the main isle
function tree(x: number, y: number, s: number): void {
  rect(x - 2, y, 4, 12 * s, [70, 48, 36], 1);
  circle(x, y - 6 * s, 12 * s, [58, 92, 58], 1);
  circle(x - 8 * s, y - 2 * s, 8 * s, [74, 110, 66], 1);
  circle(x + 8 * s, y - 2 * s, 8 * s, [74, 110, 66], 1);
}
tree(330, 700, 1); tree(700, 700, 0.9); tree(742, 700, 0.7);
tree(140, 800, 0.8); tree(880, 820, 0.8);

// small houses with warm windows on the main isle
function house(x: number, y: number, s: number): void {
  rect(x, y - 26 * s, 40 * s, 26 * s, [238, 224, 196], 1);
  poly([[x - 3 * s, y - 26 * s], [x + 20 * s, y - 40 * s], [x + 43 * s, y - 26 * s]], [150, 52, 40], 1);
  rect(x + 15 * s, y - 12 * s, 10 * s, 12 * s, [58, 40, 34], 1);
  rect(x + 6 * s, y - 20 * s, 8 * s, 8 * s, LAMP, 1);
  rect(x + 26 * s, y - 20 * s, 8 * s, 8 * s, LAMP, 1);
}
house(392, 700, 1); house(600, 700, 0.85);

// ------------------------------------------------------------------ lighthouse
const LX = 512, LY = 700; // base on the main isle
// light beam sweeping up-right, soft translucent wedge (clears the sun)
poly([[LX + 6, LY - 218], [990, LY - 420], [990, LY - 300], [LX + 6, LY - 196]], SUN, 0.16);
poly([[LX + 6, LY - 214], [950, LY - 390], [950, LY - 318], [LX + 6, LY - 200]], SUN_CORE, 0.22);
// tower: tapered white column with two red bands
poly([[LX - 26, LY], [LX + 26, LY], [LX + 15, LY - 196], [LX - 15, LY - 196]], TOWER, 1);
poly([[LX - 20, LY - 62], [LX + 20, LY - 62], [LX + 18, LY - 92], [LX - 18, LY - 92]], TOWER_BAND, 1);
poly([[LX - 17, LY - 138], [LX + 17, LY - 138], [LX + 15, LY - 164], [LX - 15, LY - 164]], TOWER_BAND, 1);
// warm shading on the tower's shaded side
poly([[LX + 2, LY], [LX + 26, LY], [LX + 15, LY - 196], [LX + 2, LY - 196]], [210, 190, 160], 0.5);
// gallery + lamp room
rect(LX - 22, LY - 210, 44, 10, INK, 1);
rect(LX - 14, LY - 238, 28, 28, INK, 1);
rect(LX - 10, LY - 234, 20, 20, LAMP, 1);
poly([[LX - 18, LY - 238], [LX + 18, LY - 238], [LX, LY - 256]], INK, 1);
circle(LX, LY - 262, 3, LAMP, 1);
// lamp glow
for (let r = 46; r > 0; r -= 4) circle(LX, LY - 224, r, SUN, 0.05 * (1 - r / 46) + 0.02);

// ------------------------------------------------------------------ type
// shadowed cream title, centred
drawTextC("THALVARA", 512 + 5, 108 + 5, 12, [20, 22, 40], 0.55);
drawTextC("THALVARA", 512, 108, 12, CREAM, 1);
// thin rules flanking the subtitle
hline(512 - 250, 512 - 150, 222, CREAM_DIM, 0.9);
hline(512 + 150, 512 + 250, 222, CREAM_DIM, 0.9);
drawTextC("THE LIGHTHOUSE ISLES", 512, 206, 3, CREAM_DIM, 1);
// dark backing strip so the footer line reads over the pale cloud band
rect(512 - 200, 940, 400, 26, [40, 32, 52], 0.55);
drawTextC("WHERE THE SEA MEETS THE SKY", 512, 946, 2, CREAM, 1);
// thin cream frame
rect(28, 28, W - 56, 4, CREAM, 0.85); rect(28, H - 32, W - 56, 4, CREAM, 0.85);
rect(28, 28, 4, H - 56, CREAM, 0.85); rect(W - 32, 28, 4, H - 56, CREAM, 0.85);

// ------------------------------------------------------------------ grain + vignette
for (let i = 0; i < 9000; i++) {
  const x = rnd() * W, y = rnd() * H;
  setP(x, y, rnd() > 0.5 ? CREAM : INK, 0.03 + rnd() * 0.03);
}
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
  const d = dx * dx + dy * dy;
  if (d > 0.72) setP(x, y, INK, (d - 0.72) * 0.35);
}

// ------------------------------------------------------------------ write
const png = encodePNG(W, H, buf);
mkdirSync(OUT, { recursive: true });
writeFileSync(OUT + "/entry.png", png);
console.log("wrote", png.length, "bytes to", OUT + "/entry.png");
