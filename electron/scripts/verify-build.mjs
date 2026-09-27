#!/usr/bin/env node
/**
 * ビルド成果物に自動操作コードが含まれているかを検査する。
 *
 * 「標準版には Advanced を含めない」を**意図ではなく検証可能な事実**にするための工程。
 * install-app の前に必ず通す。落ちたら配置しない。
 *
 *   node scripts/verify-build.mjs standard   … 含まれていないことを確認
 *   node scripts/verify-build.mjs advanced   … 含まれていることを確認
 */
import fs from 'node:fs';
import path from 'node:path';

const variant = process.argv[2];
if (!['standard', 'advanced'].includes(variant)) {
  console.error('使い方: node scripts/verify-build.mjs <standard|advanced>');
  process.exit(2);
}

const APP_NAME = variant === 'advanced' ? 'ZaikoBang Advanced.app' : 'ZaikoBang.app';
const appDir = path.join('dist', variant, 'mac-arm64', APP_NAME);
const asarPath = path.join(appDir, 'Contents', 'Resources', 'app.asar');
const plainDir = path.join(appDir, 'Contents', 'Resources', 'app');

/** asar のヘッダだけ読んでファイル一覧を得る（asar パッケージに依存しない） */
function listAsar(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    const tree = JSON.parse(json.toString('utf8').replace(/\0+$/, ''));
    const out = [];
    (function walk(node, prefix) {
      for (const [name, child] of Object.entries(node.files || {})) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.files) walk(child, p);
        else out.push(p);
      }
    })(tree, '');
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function listPlain(dir) {
  const out = [];
  (function walk(d, prefix) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), p);
      else out.push(p);
    }
  })(dir, '');
  return out;
}

let files;
if (fs.existsSync(asarPath)) files = listAsar(asarPath);
else if (fs.existsSync(plainDir)) files = listPlain(plainDir);
else {
  console.error(`成果物が見つかりません: ${appDir}\n先に npm run pack:${variant} を実行してください。`);
  process.exit(2);
}

/** Advanced にしか存在してはいけないファイル */
const ADVANCED_FILES = ['ops/advanced.mjs', 'consent.mjs', 'advanced-state.mjs'];
const found = ADVANCED_FILES.filter((f) => files.includes(f));
const missing = ADVANCED_FILES.filter((f) => !files.includes(f));

console.log(`成果物: ${appDir}`);
console.log(`同梱ファイル ${files.length} 件: ${files.join(', ')}`);

let ok = true;
if (variant === 'standard') {
  if (found.length) {
    console.error(`\nNG: 標準版に自動操作コードが含まれています → ${found.join(', ')}`);
    ok = false;
  } else {
    console.log('\nOK: 自動操作コードは含まれていません');
  }
} else {
  if (missing.length) {
    console.error(`\nNG: Advanced 版に必要なファイルがありません → ${missing.join(', ')}`);
    ok = false;
  } else {
    console.log('\nOK: 自動操作コードが含まれています（既定は無効。有効化は同意画面のみ）');
  }
}
process.exit(ok ? 0 : 1);
