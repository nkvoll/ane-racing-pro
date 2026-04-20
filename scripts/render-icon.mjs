#!/usr/bin/env node
/**
 * Rasterizes resources/icon.svg → resources/icon.png (1024²). Commit the PNG;
 * run this only when the SVG changes (npm install no longer runs this).
 */
import sharp from "sharp";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const svgPath = join(root, "resources", "icon.svg");
const outPath = join(root, "resources", "icon.png");

const svg = readFileSync(svgPath);
await sharp(svg).resize(1024, 1024).png({ compressionLevel: 9 }).toFile(outPath);
console.log("render-icon:", outPath);
