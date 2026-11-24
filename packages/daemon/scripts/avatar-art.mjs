// Draws the avatar library's pixel characters (src/rooms/avatarArt.ts) from DiceBear's "Pixel Art" (CC0 1.0).
// Run in a scratch folder with `npm i @dicebear/core@9 @dicebear/pixel-art@9 @resvg/resvg-js`, then
// `node avatar-art.mjs > lib.json`; the grids are written into avatarArt.ts from lib.json. Not a dependency of the service.
import { createAvatar } from "@dicebear/core";
import * as pixelArt from "@dicebear/pixel-art";
import { Resvg } from "@resvg/resvg-js";
const seeds = ["Ada","Bo","Cleo","Dax","Eli","Fay","Gus","Hana","Ivo","Juno","Kai","Lin","Milo","Nia","Otto","Pia","Quin","Rui","Sol","Tao","Uma","Vic","Wen","Xia","Yuki","Zed","Ari","Bea","Cy","Dot","Eve","Fox","Gil","Hal","Ira","Jo","Kit","Lux","Max","Neo","Oak","Pax","Rex","Sky","Tia","Val","Wim","Zoe"];
const out = [];
let viewBox;
for (const seed of seeds) {
  const svg = createAvatar(pixelArt, { seed, size: 16 }).toString();
  viewBox ??= svg.match(/viewBox="([^"]+)"/)?.[1];
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 16 }, shapeRendering: 0 }).render();
  const { width, height, pixels } = png;
  const palette = []; const rows = [];
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (let y = 0; y < height; y++) {
    let row = "";
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] < 128) { row += "."; continue; }
      const hex = [pixels[i], pixels[i+1], pixels[i+2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      let k = palette.indexOf(hex); if (k < 0) { palette.push(hex); k = palette.length - 1; }
      row += chars[k];
    }
    rows.push(row);
  }
  out.push({ seed, w: width, h: height, palette, rows });
}
console.error("viewBox", viewBox, "max palette", Math.max(...out.map(o => o.palette.length)));
process.stdout.write(JSON.stringify(out));
