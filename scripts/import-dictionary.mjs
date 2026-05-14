#!/usr/bin/env node
/**
 * Typeless Dictionary Importer
 *
 * Reads a previously exported dictionary JSON and imports all words into
 * the currently logged-in Typeless account via the API.
 *
 * Usage:
 *   node scripts/import-dictionary.mjs --input <path-to-export.json> [--dry-run]
 *
 * Requires: TYPELESS_VENDOR_NODE_MODULES env var (set by wrapper script).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import {
  getStorageArch,
  getStorageAppName,
  getStoragePlatform,
  getTypelessUserDataDir,
} from './typeless-env.mjs';

const USER_DATA_DIR = getTypelessUserDataDir();
const API_BASE = 'https://api.typeless.com';

function getArg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
function hasFlag(flag) { return process.argv.includes(flag); }

function deriveKey() {
  const seed = crypto.createHash('sha256')
    .update(`${getStoragePlatform()}-${getStorageArch()}`)
    .digest('hex');
  return crypto.pbkdf2Sync(seed + getStorageAppName(), 'typeless-user-service', 10000, 32, 'sha256');
}

async function loadElectronStore() {
  const vendorRoot = process.env.TYPELESS_VENDOR_NODE_MODULES;
  if (!vendorRoot) throw new Error('缺少 TYPELESS_VENDOR_NODE_MODULES 环境变量');
  const modPath = path.join(vendorRoot, 'electron-store', 'index.js');
  if (!fs.existsSync(modPath)) throw new Error(`未找到 electron-store: ${modPath}`);
  const mod = await import(pathToFileURL(modPath).href);
  return mod.default;
}

async function getAccessToken() {
  const Store = await loadElectronStore();
  const store = new Store({
    name: 'user-data',
    cwd: USER_DATA_DIR,
    encryptionKey: deriveKey(),
  });
  const raw = store.get('userData');
  if (!raw) throw new Error('未读取到 Typeless 登录态');
  const user = JSON.parse(raw);
  const token = user.refresh_token || user.access_token;
  if (!token) throw new Error('未读取到 Typeless token');
  return { token, email: user.email, user_id: user.user_id };
}

async function listExistingWords(token) {
  const res = await fetch(`${API_BASE}/user/dictionary/list?size=10000`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json();
  if (!res.ok || data?.status !== 'OK') throw new Error(`词典列表请求失败: ${res.status}`);
  return data?.data?.words || [];
}

async function addWord(token, word) {
  const body = {
    term: word.term,
    lang: word.lang,
    category: word.category,
    auto: word.auto ?? true,
    replace: word.replace ?? false,
    replace_targets: word.replace_targets || [],
  };
  const res = await fetch(`${API_BASE}/user/dictionary/add`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ok: res.ok && data?.status === 'OK', status: res.status, data };
}

async function main() {
  const inputPath = getArg('--input');
  const dryRun = hasFlag('--dry-run');

  if (!inputPath) {
    console.error('用法: node scripts/import-dictionary.mjs --input <export.json> [--dry-run]');
    process.exit(1);
  }

  const exportData = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const wordsToImport = exportData.words || [];
  if (wordsToImport.length === 0) {
    console.error('[import] 导入文件中没有词条');
    process.exit(0);
  }

  console.error(`[import] 待导入词条: ${wordsToImport.length} 个 (来源: ${exportData.account?.email || 'unknown'})`);

  const { token, email, user_id } = await getAccessToken();
  console.error(`[import] 目标账号: ${email} (${user_id})`);

  // Check existing words to avoid duplicates
  const existing = await listExistingWords(token);
  const existingTerms = new Set(existing.map(w => `${w.term}||${w.lang}`));
  console.error(`[import] 目标账号已有词条: ${existing.length} 个`);

  const toAdd = wordsToImport.filter(w => !existingTerms.has(`${w.term}||${w.lang}`));
  const skipped = wordsToImport.length - toAdd.length;
  if (skipped > 0) console.error(`[import] 跳过已存在的词条: ${skipped} 个`);
  console.error(`[import] 需要新增的词条: ${toAdd.length} 个`);

  if (dryRun) {
    console.error('[import] --dry-run 模式，不执行实际导入');
    for (const w of toAdd) console.error(`  + ${w.term} (${w.lang}, ${w.category})`);
    process.exit(0);
  }

  let success = 0;
  let failed = 0;
  for (const word of toAdd) {
    const result = await addWord(token, word);
    if (result.ok) {
      success++;
      console.error(`  ✓ ${word.term}`);
    } else {
      failed++;
      console.error(`  ✗ ${word.term}: HTTP ${result.status} ${JSON.stringify(result.data).substring(0, 100)}`);
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  console.error(`[import] 完成: 成功 ${success}, 失败 ${failed}, 跳过 ${skipped}`);
  console.log(JSON.stringify({
    ok: failed === 0,
    target: { email, user_id },
    source: exportData.account || {},
    imported: success,
    failed,
    skipped,
    total_in_source: wordsToImport.length,
  }, null, 2));
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
