#!/usr/bin/env node
/**
 * Model Download Helper
 *
 * Downloads gemma-3-1b-it-Q4_K_M.gguf from Hugging Face.
 * Run once before starting the harness.
 *
 * Usage:
 *   node scripts/download-model.js
 *   node scripts/download-model.js --quant Q8_0
 */

import { createWriteStream, mkdirSync, existsSync, statSync } from 'fs';
import { get } from 'https';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODELS_DIR = join(__dirname, '..', 'backend', 'models');
const QUANT_ARG = process.argv.find(a => a.startsWith('--quant='))?.split('=')[1] ?? 'Q4_K_M';

const MODEL_FILES = {
  Q4_K_M: 'gemma-3-1b-it-Q4_K_M.gguf',
  Q8_0:   'gemma-3-1b-it-Q8_0.gguf',
  IQ3_M:  'gemma-3-1b-it-IQ3_M.gguf',
};

const HF_REPO = 'bartowski/gemma-3-1b-it-GGUF';
const filename = MODEL_FILES[QUANT_ARG];

if (!filename) {
  console.error(`Unknown quantization: ${QUANT_ARG}`);
  console.error(`Available: ${Object.keys(MODEL_FILES).join(', ')}`);
  process.exit(1);
}

const destPath = join(MODELS_DIR, filename);
const hfUrl = `https://huggingface.co/${HF_REPO}/resolve/main/${filename}?download=true`;

mkdirSync(MODELS_DIR, { recursive: true });

if (existsSync(destPath)) {
  const sizeMb = (statSync(destPath).size / 1024 / 1024).toFixed(0);
  console.log(`\nModel already exists: ${destPath} (${sizeMb} MB)`);
  console.log('Delete it to re-download.');
  process.exit(0);
}

console.log(`\nDownloading ${filename}...`);
console.log(`Source: ${hfUrl}`);
console.log(`Dest:   ${destPath}\n`);

function download(url, dest, redirectCount = 0) {
  if (redirectCount > 5) { console.error('Too many redirects'); process.exit(1); }

  get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      return download(res.headers.location, dest, redirectCount + 1);
    }
    if (res.statusCode !== 200) {
      console.error(`HTTP ${res.statusCode}`);
      process.exit(1);
    }

    const total = parseInt(res.headers['content-length'] || '0', 10);
    let downloaded = 0;
    let lastPrint = 0;

    const file = createWriteStream(dest);
    res.on('data', chunk => {
      downloaded += chunk.length;
      file.write(chunk);
      const now = Date.now();
      if (now - lastPrint > 2000) {
        const pct = total > 0 ? ((downloaded / total) * 100).toFixed(1) : '?';
        const mb = (downloaded / 1024 / 1024).toFixed(1);
        process.stdout.write(`\r  ${mb} MB  (${pct}%)`);
        lastPrint = now;
      }
    });

    res.on('end', () => {
      file.end();
      console.log(`\n\nDownload complete: ${dest}`);
      console.log(`\nNext step:`);
      console.log(`  cd backend && cp .env.example .env`);
      console.log(`  # MODEL_PATH is already set to ./models/${filename}`);
      console.log(`  npm run dev\n`);
    });

    res.on('error', err => { console.error('Stream error:', err); process.exit(1); });
  }).on('error', err => { console.error('Request error:', err); process.exit(1); });
}

download(hfUrl, destPath);
