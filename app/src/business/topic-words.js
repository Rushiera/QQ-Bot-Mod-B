// 本群话题词 —— 收工轮产出，提示词参考（不做触发门）。
// [qqagent-engage-patch:topic-words]
//
// 🔴 R3-5（2026-10-30）起本文件**只做转发**：实现已并入 group-memory.js
//    （话题词与群记 topic 同源，两份实现会让「本轮话题」有两个真相）。
//    保留本文件是因为多处 import 指向它；新代码请直接 import group-memory.js。
import {
  extractTopicWords, writeTopicWords, readTopicWords, formatTopicWordsForPrompt, topicWordsFile
} from './group-memory.js';

export { extractTopicWords, writeTopicWords, readTopicWords, formatTopicWordsForPrompt, topicWordsFile };
