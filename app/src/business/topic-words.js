// 本群话题词 —— 收工轮产出，提示词参考（不做触发门）。
// [qqagent-engage-patch:topic-words]
//
// 文件：data/memory/<chat>/_topics.json
// 形态：{ chatKey, words: [...], updatedAt, rollovers }
//
// 用途：只进【记忆】段，帮模型判断"这条消息跟本群常聊的事有没有关系"；
// 冷场开话题时也可当选题参考。**不参与任何触发判定** —— 触发权完全在模型手里。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const MAX_WORDS = 12;

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 话题词文件路径（与 _session.json 同址，下划线开头避开成员文件语义）。 */
export function topicWordsFile(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey), '_topics.json');
}

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 从收工轮正文里解析话题词行。
 * 约定形态：「话题词：词1、词2、词3」（也容忍 逗号 / 空格 / 顿号 混用）。
 * 解析不到就返回空数组 —— 本轮不更新词表，保留上一版（宁可不换，不可清空）。
 */
export function extractTopicWords(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    const m = /话题词\s*[:：]\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const words = m[1]
      .split(/[、,，\s\/]+/)
      .map((w) => w.replace(/^[\-\*\d.、)]+/, '').trim())
      .filter((w) => w && w.length <= 12 && !/^话题词/.test(w));
    const seen = new Set();
    const out = [];
    for (const w of words) {
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= MAX_WORDS) break;
    }
    if (out.length) return out;
  }
  return [];
}

/** 写话题词（收工轮产出）。空数组不写 —— 保留上一版。 */
export function writeTopicWords(chatKey, words, meta = {}) {
  const list = (Array.isArray(words) ? words : []).map((w) => String(w).trim()).filter(Boolean).slice(0, MAX_WORDS);
  if (!list.length) return null;
  const payload = {
    chatKey: String(chatKey),
    words: list,
    updatedAt: Date.now(),
    rollovers: Math.max(0, Number(meta.rollovers) || 0)
  };
  writeJson(topicWordsFile(chatKey), payload);
  return payload;
}

/** 读话题词；没有就返回 null。 */
export function readTopicWords(chatKey) {
  const raw = readJson(topicWordsFile(chatKey), null);
  const words = Array.isArray(raw?.words) ? raw.words.map((w) => String(w)).filter(Boolean) : [];
  if (!words.length) return null;
  return { words, updatedAt: Number(raw?.updatedAt) || 0, rollovers: Number(raw?.rollovers) || 0 };
}

/** 渲染成【记忆】段的一块（会话级要点之后、群友印象之前）。 */
export function formatTopicWordsForPrompt(chatKey) {
  const t = readTopicWords(chatKey);
  if (!t) return '';
  return '【本群常聊的话题词】' + t.words.join('、') + '（参考用：跟这些沾边的消息更值得接，别硬往上靠）';
}
