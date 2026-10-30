// 〔记忆视图 / 设置加载 / 价格表状态〕——M9 拆分第 6 段
'use strict';
// ── 记忆视图 ──
async function loadMemoryView() {
  try {
    const [cfg, chats] = await Promise.all([api('/api/config'), api('/api/chats')]);
    state.config = cfg;
    const files = await api('/api/memory-files');
    state.memoryFiles = files.files || [];
    state.chats = chats.chats || [];
    // 用后端状态校正本地记录：覆盖"页面刚刷新""SSE 断连期间状态变化"两种情况。
    // 后端 consolidating 是唯一可信来源（它在 orchestrator 里真实维护）。
    for (const f of state.memoryFiles) {
      if (f.consolidating) {
        if (!state.consolidating[f.chatKey]) {
          state.consolidating[f.chatKey] = { startedAt: Date.now() };
        }
      } else if (state.consolidating[f.chatKey]) {
        // 后端已经不在整理，说明完成了（结果由 SSE 事件补充）
        delete state.consolidating[f.chatKey];
        if (!state.consolidateResult[f.chatKey]) {
          state.consolidateResult[f.chatKey] = { note: '整理完成', at: Date.now() };
        }
      }
    }
    renderMemoryList();
    if (state.currentMemoryChatKey) loadMemoryDetail(state.currentMemoryChatKey);
  } catch (e) {
    console.error('加载记忆视图失败:', e);
    $('#memory-items').innerHTML = '<div class="list-head muted">加载失败</div>';
  }
}

// 整理中的计时刷新：让"已 Ns"持续走动，并在没有活跃任务时自动停掉。
// 整理可能持续几十秒，用户切走再切回时靠它维持可见状态。
let consolidateTicker = null;
function startConsolidateTicker() {
  if (consolidateTicker) return;
  consolidateTicker = setInterval(() => {
    const active = Object.keys(state.consolidating);
    if (!active.length) {
      clearInterval(consolidateTicker);
      consolidateTicker = null;
      if (state.tab === 'memory') renderMemoryList();
      return;
    }
    if (state.tab !== 'memory') return;
    // 只更新计时文本，不重建整个详情页（避免打断用户阅读/滚动）
    const key = state.currentMemoryChatKey;
    const el = $('#mem-consolidate-status');
    if (key && state.consolidating[key] && el) {
      const sec = Math.max(0, Math.round((Date.now() - (state.consolidating[key].startedAt || Date.now())) / 1000));
      el.textContent = `整理中…（已 ${sec}s）`;
    }
    renderMemoryList();
  }, 1000);
}

function renderMemoryList() {
  const box = $('#memory-items');
  const files = state.memoryFiles || [];
  const names = {};
  for (const c of state.chats || []) names[c.key] = formatChatTitle(c.key, chatNameOf(c.key));
  if (!files.length) {
    box.innerHTML = '<div class="list-head muted">还没有任何记忆（等机器人使用记忆工具后才会出现）</div>';
    return;
  }
  box.innerHTML = files.map((f) => {
    const key = f.chatKey;
    const busy = !!state.consolidating[key];
    // 整理中：在列表项上直接标出，切页签回来也能一眼看到
    const busyHtml = busy
      ? `<span class="unread-pill" style="background:var(--orange)">整理中…</span>`
      : '';
    // 发言档位标记（[qqagent-level-patch:ui-list-badge]）——本群当前几档（五档；未设置 = 标准档 3）
    const levelHtml = (() => {
      const id = String(key).split(':')[1] || '';
      const lv = engageLevelOf(state.config || {}, id);
      if (!lv) return '';
      const color = lv.level === 1 ? 'var(--blue,#3b82f6)' : (lv.level >= 4 ? 'var(--orange)' : 'var(--muted,#8a8f98)');
      return `<span class="unread-pill" style="background:${color}" title="发言档位 ${lv.level}/${lv.count}：${esc(lv.name)}">${lv.level === 1 ? '🤫 ' : ''}${esc(lv.name)}</span>`;
    })();
    // 余额后缀标记（[qqbotb-balance:ui-list-badge]）——本群开着就显示当前余额值
    const balanceHtml = (() => {
      const id = String(key).split(':')[1] || '';
      const bal = balanceRuleOf(state.config || {}, id);
      if (!bal || !bal.on) return '';
      return `<span class="unread-pill" style="background:var(--green,#2e9e5b)" title="群名片后缀已开：每 ${bal.minutes} 分钟刷「${esc(bal.marker)}${esc(bal.amount)}」到本号群名片">💰 ${esc(bal.amount)}</span>`;
    })();
    // 语音伴随标记（[qqbotb-voicereply:ui-list-badge]）——本群开着就显示 🔊
    const voiceHtml = (() => {
      const id = String(key).split(':')[1] || '';
      const vc = voiceRuleOf(state.config || {}, id);
      if (!vc || !vc.on) return '';
      return `<span class="unread-pill" style="background:var(--purple,#8b5cf6)" title="语音伴随已开：本号每次发言都会再念一遍日语发回本群（依田芳乃 · v4.1-Small）">🔊 语音</span>`;
    })();
    // [qqagent-memory-patch:ui-list-sub]
    const sub = busy
      ? '正在整理本群记忆'
      : (f.memberCount || f.groupCount || f.groupArchived
        // 归档计数也进摘要（记忆不节流：现行池之外还有多少）——[qqagent-memory-patch:no-throttle-ui-list]
        ? `${f.memberCount} 位群友 · ${f.impressionCount} 条印象 · 群记 ${f.groupCount || 0} 条`
          + ((f.groupArchived || f.memberArchived) ? ` · 归档 ${(f.groupArchived || 0) + (f.memberArchived || 0)} 条` : '')
        : '暂无群友印象');
    const delBtn = (f.memberCount || f.impressionCount || f.groupCount)
      ? `<button class="btn btn-small btn-danger mem-del-chat" data-key="${esc(key)}" title="删除本会话的全部记忆（所有群友的印象）">删除</button>`
      : '';
    return `
      <div class="chat-item ${key === state.currentMemoryChatKey ? 'selected' : ''}" data-key="${esc(key)}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(names[key] || key)}</span>
          ${levelHtml}<!-- [qqagent-level-patch:ui-list-html] -->
          ${balanceHtml}<!-- [qqbotb-balance:ui-list-html] -->
          ${voiceHtml}<!-- [qqbotb-voicereply:ui-list-html] -->
          ${busyHtml}
          ${delBtn}
        </div>
        <div class="chat-item-sub">${esc(sub)}</div>
        <div class="session-meta"><span>更新于 ${fmtTime(f.updatedAt || 0)}</span></div>
      </div>`;
  }).join('');
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => {
      state.currentMemoryChatKey = el.dataset.key;
      renderMemoryList();
      loadMemoryDetail(state.currentMemoryChatKey);
    });
  });
  // 删除本会话的全部记忆（stopPropagation：别触发选中详情）
  $$('.mem-del-chat', box).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const key = btn.dataset.key;
      const name = names[key] || key;
      const cnt = state.consolidating[key] ? 1 : 0;
      if (cnt) { alert('该会话记忆正在整理中，稍后再删'); return; }
      if (!(await uiConfirm(`确定删除「${name}」的全部记忆？\n\n所有群友的印象都会被删除，此操作不可撤销。`))) return;
      try {
        await api(`/api/memory-files/${encodeURIComponent(key.replace(':', '_'))}`, { method: 'DELETE' });
        if (state.currentMemoryChatKey === key) {
          state.currentMemoryChatKey = null;
          const detail = $('#memory-detail');
          if (detail) detail.innerHTML = '<div class="empty-hint">已删除。从左侧选择一个会话查看记忆</div>';
        }
        await loadMemoryView();
      } catch (err) {
        alert(`删除失败：${err.message}`);
      }
    });
  });
}

async function loadMemoryDetail(chatKey) {
  const detail = $('#memory-detail');
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [mem, cfg] = await Promise.all([
      api(`/api/memory-files/${chatKey.replace(':', '_')}`),
      api('/api/config')
    ]);
    const notes = cfg.memberNotes || {};
    // 指定为机器人的群友 QQ（[qqagent-botguard-patch:ui-mem-bot-list]）——🤖 bot 开关的状态源
    const botMembers = ((cfg.engage && cfg.engage.botGuard && cfg.engage.botGuard.members) || []).map(String);
    // 发言档位（[qqagent-level-patch:ui-detail-state]）——五档选择器的状态源（未设置 = 标准档 3）
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const curLevel = engageLevelOf(cfg, chatId);
    // 回应参数（每群友 0~100，缺省 100）——[qqagent-rapport-patch:ui-detail-map]
    const rapportMap = (() => {
      const out = {};
      for (const r of (Array.isArray(mem.rapport) ? mem.rapport : [])) out[String(r.userId)] = r;
      return out;
    })();
    const rapportBadge = (qq) => {
      const r = rapportMap[String(qq)];
      if (!r) return ' <span class="muted" title="回应参数（初始 100；越低 = 他越不想跟你聊）">回应 100</span>';
      const why = r.lastReason ? ' · ' + r.lastReason : '';
      const title = '回应参数 ' + r.score + '/100' + why;
      return r.score < 80
        ? ' <span style="color:#c0392b" title="' + esc(title) + '">回应 ' + Number(r.score) + '</span>'
        : ' <span class="muted" title="' + esc(title) + '">回应 ' + Number(r.score) + '</span>';
    };
    const members = Array.isArray(mem.members) ? mem.members : [];
    // 群记（群级记忆）——[qqagent-memory-patch:ui-group-data]
    const groupEntries = Array.isArray(mem.group) ? mem.group : [];
    const GROUP_KIND_LABEL = { lore: '梗/黑话', rule: '群规约定', relation: '关系角色', project: '长期项目', topic: '在聊什么' };
    const groupRows = groupEntries.map(function (e) {
      return '<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0">'
        + '<span class="muted" style="min-width:64px">' + esc(GROUP_KIND_LABEL[e.kind] || e.kind) + '</span>'
        + '<span style="flex:1">' + esc(e.content) + '</span>'
        + '<button class="btn btn-small btn-danger mem-del-group" data-id="' + esc(e.id) + '">删</button>'
        + '</div>';
    }).join('');
    const groupHtml = '<div style="margin:10px 0">'
      + '<div class="list-head muted"><span>群记（本群长期事实 · ' + groupEntries.length + ' 条'
      + ((mem.archiveStats && mem.archiveStats.group) ? ' · 归档 ' + mem.archiveStats.group + ' 条' : '') + '）</span>'
      + '<button class="btn btn-small" id="mem-add-group-btn">＋ 添加群记</button></div>'
      + '<div id="mem-group-list">' + (groupRows || '<div class="muted" style="padding:6px 0">还没有群记（梗 / 群规 / 关系 / 项目 / 在聊什么）——点「整理本群记忆」让模型从聊天记录里提炼。</div>') + '</div>'
      + '</div>';
    const membersHtml = kind === 'group'
      ? `<div class="field" style="margin:8px 0"><button class="btn btn-small" id="mem-load-members-btn">拉取群成员列表（编辑备注）</button><span id="mem-members-status" class="muted"></span></div><div id="mem-members"></div>`
      : '';
    const rows = members.map((m) => {
      const who = notes[String(m.userId)] || m.name || m.userId || '某人';
      const qq = m.userId ? ` <span class="muted">(QQ ${esc(m.userId)})</span>` : '';
      const imps = m.impressions.map((e) => `- ${e.content}`).join('\n');
      // 必须是 <details> 才能开合：div+summary 点了不会收起
      return `<details class="collapsible mem-fold" open>
        <summary>
          <span class="mem-who">${esc(who)}${qq}（${m.impressions.length} 条）${rapportBadge(String(m.userId))}</span>
          <span class="mem-actions">
            <button class="btn btn-small mem-bot-toggle" data-qq="${esc(m.userId)}" title="指定为机器人：对 TA 的回复限制为 240 秒 1 条（点一下切换）">🤖 bot</button>
            <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}">编辑</button>
            <button class="btn btn-small mem-refresh-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" title="让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼">更新记忆</button>
            <button class="btn btn-small btn-danger mem-del-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" title="删除这个人的全部印象">删除</button>
          </span>
        </summary>
        <div class="coll-body">${esc(imps)}</div>
      </details>`;
    }).join('');
    // 整理状态从 state 恢复：切页签回来 / 刷新页面后依然可见
    const busy = !!state.consolidating[chatKey];
    const result = state.consolidateResult[chatKey];
    let consolidateStatusHtml = '';
    if (busy) {
      const started = state.consolidating[chatKey]?.startedAt || Date.now();
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">整理中…（已 ${sec}s）</span>`;
    } else if (result) {
      const ago = Math.max(0, Math.round((Date.now() - (result.at || 0)) / 1000));
      const when = ago < 60 ? `${ago}s 前` : `${Math.round(ago / 60)} 分钟前`;
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">${esc(result.note)}（${when}）</span>`;
    } else {
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted"></span>`;
    }
    // 发言档位选择器（[qqagent-level-patch:ui-detail-btn]）——仅群聊显示；五档写进 engage.levelByChat
    const levelSelectHtml = kind === 'group' && curLevel
      ? '<label class="muted" for="mem-level-sel" title="发言档位：只调这一拍要不要开口（入场率）；发言配额 5 条/2 分钟与浏览节拍不受影响">发言档位</label>'
        + ' <select id="mem-level-sel" class="btn btn-small" style="min-width:8em">'
        + LEVEL_NAMES.map((n, i) => `<option value="${i + 1}"${curLevel.level === i + 1 ? ' selected' : ''}>${i + 1}· ${esc(n)}</option>`).join('')
        + '</select>'
      : '';
    // 余额后缀开关 + 余额值 + 立即刷新（[qqbotb-balance:ui-detail-head]）——仅群聊；默认关，按群开
    const balState = kind === 'group' ? balanceRuleOf(cfg, chatId) : null;
    const balanceCtlHtml = balState
      ? '<label class="muted" title="打开后每 ' + balState.minutes + ' 分钟把「' + esc(balState.marker) + 'xx.xx」刷到本号的群名片尾部（只动这个群）">'
        + '<input type="checkbox" id="mem-balance-chk"' + (balState.on ? ' checked' : '') + '> 💰 余额后缀</label>'
        + ' <input id="mem-balance-val" type="text" class="btn btn-small" style="width:6em" value="' + esc(balState.amount) + '" title="余额（两位小数，0 或正数）——所有开启的群共用这一个值">'
        + ' <button class="btn btn-small" id="mem-balance-sync" title="立即按当前余额刷一次群名片（不必等 30 分钟）">刷新</button>'
        + ' <span id="mem-balance-status" class="muted"></span>'
      : '';
    // 语音伴随开关（[qqbotb-voicereply:ui-detail-head]）——仅群聊；默认关，按群开
    const vcState = kind === 'group' ? voiceRuleOf(cfg, chatId) : null;
    const voiceCtlHtml = vcState
      ? '<label class="muted" title="打开后本号在本群每发一句话，都会再用 IrodoriTTS 念一遍日语发回本群">'
        + '<input type="checkbox" id="mem-voice-chk"' + (vcState.on ? ' checked' : '') + '> 🔊 语音伴随</label>'
        + ' <span class="muted" style="font-size:12px">依田芳乃 · v4.1-Small · 每句 ≤' + vcState.maxChars + ' 字</span>'
      : '';
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))} 的记忆</h2>
        <div class="sub">
          <span>每个群友一个文件：data/memory/${esc(chatKey.replace(':', '_'))}/&lt;QQ&gt;.json</span>
          <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
          <button class="btn btn-small" id="mem-consolidate-btn" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理本群记忆'}</button>
          ${levelSelectHtml}<!-- [qqagent-level-patch:ui-detail-html] -->
          ${balanceCtlHtml}<!-- [qqbotb-balance:ui-detail-html] -->
          ${voiceCtlHtml}<!-- [qqbotb-voicereply:ui-detail-html] -->
          ${consolidateStatusHtml}
        </div>
      </div>
      ${groupHtml}
      ${membersHtml}
      ${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}
    `;
    const loadMembersBtn = $('#mem-load-members-btn');
    if (loadMembersBtn) loadMembersBtn.addEventListener('click', () => loadGroupMembers(chatId, chatKey));
    // 🤖 bot 开关（[qqagent-botguard-patch:ui-mem-bot-handler]）—— 指定为机器人的群友
    // 会被发送面限频（240 秒 1 条）；只影响发送，不影响模型思考。
    $$('.mem-bot-toggle', detail).forEach((el) => {
      const qq = String(el.dataset.qq || '');
      if (!/^\d{1,15}$/.test(qq)) { el.style.display = 'none'; return; }
      const on = botMembers.includes(qq);
      el.classList.toggle('btn-primary', on);
      el.textContent = on ? '🤖 bot ✓' : '🤖 bot';
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleBotMember(qq, chatKey);
      });
    });
    // 发言档位选择器（[qqagent-level-patch:ui-detail-bind]）——变更即写 engage.levelByChat
    const levelSelEl = detail.querySelector('#mem-level-sel');
    if (levelSelEl && kind === 'group') {
      levelSelEl.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setEngageLevel(chatId, chatKey, Number(levelSelEl.value));
      });
    }
    // 余额后缀（[qqbotb-balance:ui-detail-bind]）——开关写 engage.balance.chats 并立即刷一次；
    // 输入框改值（失焦 / 回车）写 engage.balance.value；「刷新」按钮立刻同步名片。
    const balChkEl = detail.querySelector('#mem-balance-chk');
    if (balChkEl && kind === 'group') {
      balChkEl.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleBalanceChat(chatId, chatKey, balChkEl.checked);
      });
    }
    const balValEl = detail.querySelector('#mem-balance-val');
    if (balValEl && kind === 'group') {
      const commit = () => setBalanceValue(chatId, chatKey, balValEl.value);
      balValEl.addEventListener('change', commit);
      balValEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
      });
    }
    const balSyncEl = detail.querySelector('#mem-balance-sync');
    if (balSyncEl && kind === 'group') {
      balSyncEl.addEventListener('click', () => syncBalanceNow(chatId, chatKey));
    }
    // 语音伴随（[qqbotb-voicereply:ui-detail-bind]）——开关写 engage.voiceReply.chats；
    // 下一句发言起生效（发送面每次发文字都现读配置，不用重启）。
    const voiceChkEl = detail.querySelector('#mem-voice-chk');
    if (voiceChkEl && kind === 'group') {
      voiceChkEl.addEventListener('change', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleVoiceChat(chatId, chatKey, voiceChkEl.checked);
      });
    }
    $$('.mem-edit-imp', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const m = members.find((x) => String(x.userId) === String(el.dataset.qq));
        openMemberImpressModal(chatKey, m || { userId: el.dataset.qq, name: el.dataset.name, impressions: [] });
      });
    });
    // 删除单个群友的全部印象（表面化按钮，不必进编辑弹窗）
    $$('.mem-del-imp', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.qq || '').trim();
        const name = el.dataset.name || uid;
        if (!(await uiConfirm(`确定删除「${name}」的全部印象？此操作不可撤销。`))) return;
        try {
          await api(`/api/memory-files/${encodeURIComponent(chatKey.replace(':', '_'))}/members/${encodeURIComponent(uid)}`, { method: 'DELETE' });
          await loadMemoryDetail(chatKey);
          await loadMemoryView();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
    // 群记：添加 / 删除（[qqagent-memory-patch:ui-group-handlers]）
    $$('.mem-del-group', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await api('/api/memory-files/' + encodeURIComponent(chatKey.replace(':', '_')) + '/group/' + encodeURIComponent(el.dataset.id), { method: 'DELETE' });
          await loadMemoryDetail(chatKey);
        } catch (err) { alert('删除失败：' + err.message); }
      });
    });
    $('#mem-add-group-btn')?.addEventListener('click', async () => {
      const kind = await uiPrompt('分类：lore 梗/黑话 · rule 群规约定 · relation 关系角色 · project 长期项目 · topic 在聊什么', 'lore');
      if (!kind) return;
      const content = await uiPrompt('内容（≤200 字）', '');
      if (!content) return;
      try {
        await api('/api/memory-files/' + encodeURIComponent(chatKey.replace(':', '_')) + '/group', {
          method: 'POST',
          body: JSON.stringify({ kind: String(kind).trim(), content: String(content).trim() })
        });
        await loadMemoryDetail(chatKey);
        await loadMemoryView();
      } catch (err) { alert('添加失败：' + err.message); }
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal(chatKey, null));
    // 针对单个群友更新记忆：有印象→整理合并；无印象→从聊天记录提炼
    $$('.mem-refresh-imp', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.qq || '').trim();
        if (!/^\d{1,15}$/.test(uid)) { alert('该群友缺少 QQ 号，无法定位聊天记录'); return; }
        el.disabled = true;
        const old = el.textContent;
        el.textContent = '更新中…';
        // 同样记进 state，切页签回来后仍能看到进行中
        state.consolidating[chatKey] = { startedAt: Date.now() };
        delete state.consolidateResult[chatKey];
        startConsolidateTicker();
        renderMemoryList();
        try {
          await api('/api/memory-files/consolidate', {
            method: 'POST',
            body: JSON.stringify({ chatKey, userIds: [uid] })
          });
          el.textContent = '已提交 ✓';
        } catch (err) {
          el.textContent = '失败';
          alert(`更新记忆失败：${err.message}`);
        }
        setTimeout(() => { el.disabled = false; el.textContent = old; }, 2500);
      });
    });
    $('#mem-consolidate-btn')?.addEventListener('click', async () => {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      // 立刻记进 state：即使马上切走页签，回来也能看到"整理中"
      state.consolidating[chatKey] = { startedAt: Date.now() };
      delete state.consolidateResult[chatKey];
      startConsolidateTicker();
      renderMemoryList();
      if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
      if (status) status.textContent = '整理中…';
      try {
        const r = await api('/api/memory-files/consolidate', {
          method: 'POST',
          body: JSON.stringify({ chatKey })
        });
        if (r.error) {
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${r.error}`, at: Date.now(), failed: true };
          if (status) status.textContent = `失败：${r.error}`;
          if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
          renderMemoryList();
        }
        // 成功时保持"整理中"，等 SSE 的 consolidate-done 事件来收尾
      } catch (e) {
        delete state.consolidating[chatKey];
        state.consolidateResult[chatKey] = { note: `失败：${e.message}`, at: Date.now(), failed: true };
        if (status) status.textContent = `失败：${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
        renderMemoryList();
      }
    });
    // 若本群正在整理，启动计时刷新（切回来时也能接着走）
    if (state.consolidating[chatKey]) startConsolidateTicker();
    // 选中会话后记忆详情整体淡入
    uiEnter(detail);
  } catch (e) {
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/** 编辑/添加某个群友的印象（一行一条，保存后整体替换）。 */
function openMemberImpressModal(chatKey, member) {
  const isEdit = !!(member && member.userId);
  const userId = member?.userId || '';
  const name = member?.name || '';
  const imps = (member?.impressions || []).map((e) => e.content).join('\n');
  const cfg = state.config || {};
  const notes = cfg.memberNotes || {};
  const note = notes[String(userId)] || '';
  const overlay = modelModalShell({
    head: isEdit ? `编辑群友印象：${note || name || userId}` : '添加群友印象',
    body: `
      ${isEdit ? `
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="mi-qq" value="${esc(userId)}" readonly /></div>
        <div class="field"><label>QQ 昵称</label><input type="text" id="mi-nickname" value="${esc(name)}" readonly /></div>
        <div class="field"><label>群内昵称</label><input type="text" id="mi-card" value="${esc(member?.card || '')}" readonly /></div>
      </div>
      <div class="field"><label>QQ agent 对群友的当前备注</label><input type="text" id="mi-note" value="${esc(note)}" placeholder="留空则使用原群名片/昵称" /></div>` : `
      <div class="field"><label>QQ 号（必填）</label><input type="text" id="mi-qq" value="${esc(userId)}" /></div>
      <div class="field"><label>名字（备注名/群名片/昵称）</label><input type="text" id="mi-name" value="${esc(name)}" /></div>`}
      <div class="field"><label>印象内容（一行一条；留空 = 删除该成员全部印象）</label><textarea id="mi-imps" style="min-height:160px" placeholder="老王喜欢钓鱼，周末常不在&#10;说话爱玩梗，别太认真">${esc(imps)}</textarea></div>`,
    foot: `<button class="btn" id="mi-cancel">取消</button>
           ${isEdit ? '<button class="btn btn-danger" id="mi-del">删除此人</button>' : ''}
           <button class="btn btn-primary" id="mi-save">保存</button>`
  });
  overlay.querySelector('#mi-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mi-save').addEventListener('click', async () => {
    const qq = ($('#mi-qq')?.value || '').trim();
    const nm = ($('#mi-name')?.value || $('#mi-nickname')?.value || '').trim();
    const newNote = ($('#mi-note')?.value || '').trim();
    const lines = ($('#mi-imps')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!/^\d{1,15}$/.test(qq)) { alert('QQ 号必须是数字'); return; }
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${qq}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nm, note: newNote, impressions: lines })
      });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mi-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!(await uiConfirm(`确定删除 ${note || name || userId} 的全部印象？`))) return;
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, { method: 'DELETE', body: '{}' });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}

/**
 * 指定 / 取消指定某个群友为机器人（记忆页「🤖 bot」开关）。
 * [qqagent-botguard-patch:ui-toggle-fn]
 *
 * 写进 config.engage.botGuard.members —— 发送面对 TA 的回复限频 240 秒 1 条；
 * **不影响送 LLM 思考**（模型照常跑，只是发不出去）。名单是全局 QQ 清单：
 * 同一个机器人在别的群也一并受限。
 */
/**
 * 开 / 关某群的「安静模式」（记忆页「🤫 安静模式」开关）。
 * [qqagent-quiet-patch:ui-toggle-fn]
 *
 * 写进 config.engage.quiet.chats —— 该群"能不发言就不发言"：不参与闲聊，
 * 只有被 @ / 拍一拍 才回应；每 6 小时跑一次"只整理不发言"的记忆沉淀轮。
 * 存档与记忆功能不受影响（消息照常入库、归档与记忆整理照常）。
 */
/**
 * 设置某群的发言档位（[qqagent-level-patch:ui-set-fn]）。
 *
 * 写 config.engage.levelByChat[群号] = 1~5；
 * 选 1（冰封）时同时把该群并入 engage.quiet.chats —— 老版本/老路径（quiet-mode.js 的
 * isQuietChat）也认得出"冰封"，两个字段语义一致，不产生分歧。
 * 选 2~5 时从 quiet.chats 摘掉该群（否则 isQuietChat 恒真，冰封语义会盖住档位）。
 */
async function setEngageLevel(groupId, chatKey, level) {
  const id = String(groupId || '').trim();
  if (!/^\d{1,15}$/.test(id)) { alert('该会话缺少群号，无法设置发言档位'); return; }
  const n = Math.min(5, Math.max(1, Math.round(Number(level) || 3)));
  const cfg = state.config || await api('/api/config');
  const map = { ...(((cfg.engage || {}).levelByChat) || {}) };
  map[id] = n;
  const quietCur = ((cfg.engage && cfg.engage.quiet && cfg.engage.quiet.chats) || []).map(String);
  const quietNext = n === 1
    ? (quietCur.includes(id) ? quietCur : [...quietCur, id])
    : quietCur.filter((x) => x !== id);
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { levelByChat: map, quiet: { chats: quietNext } } })
    });
    state.config = data.config;
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    renderMemoryList();
  } catch (e) {
    alert(`保存失败：${e.message}`);
  }
}

/**
 * 开 / 关某群的余额后缀（记忆页「💰 余额后缀」开关）。[qqbotb-balance:ui-toggle-fn]
 *
 * 写 config.engage.balance.chats——开着时宿主每 intervalMs（默认 30 分钟）把
 * 「marker + 余额」刷到本号在该群的**群名片**尾部；关掉后宿主不再动这个群
 * （已经加上的后缀不会自己消失——名片归群，要撤自己改回来）。
 * 打开后立即刷一次，不用等下一个周期。
 */
async function toggleBalanceChat(groupId, chatKey, on) {
  const id = String(groupId || '').trim();
  if (!/^\d{1,15}$/.test(id)) { alert('该会话缺少群号，无法设置余额后缀'); return; }
  const cfg = state.config || await api('/api/config');
  const cur = ((((cfg.engage || {}).balance || {}).chats) || []).map(String);
  const next = on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id);
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { balance: { chats: next } } })
    });
    state.config = data.config;
    if (on) await syncBalanceNow(id, chatKey, true);
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    renderMemoryList();
  } catch (e) {
    alert(`保存失败：${e.message}`);
  }
}

/** 写余额值（[qqbotb-balance:ui-value-fn]）——所有开启的群共用这一个数；本群开着就立即刷。 */
async function setBalanceValue(groupId, chatKey, raw) {
  const n = Number(String(raw == null ? '' : raw).trim());
  if (!Number.isFinite(n) || n < 0) { alert('余额要填 0 或正数（如 12.34）'); return; }
  const value = Math.round(n * 100) / 100;
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { balance: { value } } })
    });
    state.config = data.config;
    const st = balanceRuleOf(state.config, groupId);
    if (st && st.on) await syncBalanceNow(groupId, chatKey, true);
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    renderMemoryList();
  } catch (e) {
    alert(`保存失败：${e.message}`);
  }
}

/** 立即刷一次群名片余额后缀（[qqbotb-balance:ui-sync-fn]）——按钮 / 开关 / 改值后用；silent 不弹窗。 */
async function syncBalanceNow(groupId, chatKey, silent) {
  const statusEl = document.querySelector('#mem-balance-status');
  if (statusEl) statusEl.textContent = '刷新中…';
  try {
    const r = await api('/api/balance/sync', {
      method: 'POST',
      body: JSON.stringify({ chat: String(groupId || '') })
    });
    const one = ((r && r.results) || [])[0] || {};
    const text = r && r.ok
      ? (one.skipped ? '名片已是最新' : (one.card ? '名片已刷成 ' + one.card : '已刷新'))
      : '刷新失败：' + (one.reason || (r && r.error) || '未知原因');
    if (statusEl) statusEl.textContent = text;
    else if (!silent) alert(text);
  } catch (e) {
    if (statusEl) statusEl.textContent = '刷新失败：' + e.message;
    else if (!silent) alert(`刷新失败：${e.message}`);
  }
}

/** 取某群的余额后缀状态（[qqbotb-balance:ui-helpers]）——{on, amount, marker, minutes}；无群号返回 null。 */
function balanceRuleOf(cfg, groupId) {
  const id = String(groupId || '').trim();
  if (!/^\d{1,15}$/.test(id)) return null;
  const bal = ((cfg && cfg.engage && cfg.engage.balance) || {});
  const chats = (Array.isArray(bal.chats) ? bal.chats : []).map(String);
  const n = Number(bal.value);
  const ms = Number(bal.intervalMs);
  return {
    on: chats.includes(id),
    amount: Number.isFinite(n) && n >= 0 ? n.toFixed(2) : '0.00',
    marker: String(bal.marker || '@余额'),
    minutes: Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : 30
  };
}

/**
 * 取某群的语音伴随状态（[qqbotb-voicereply:ui-helpers]）——{on, runMode, maxChars}；无群号返回 null。
 *
 * @param {object} cfg 配置
 * @param {string|number} groupId 群号
 * @returns {object|null} 状态
 */
function voiceRuleOf(cfg, groupId) {
  const id = String(groupId || '').trim();
  if (!/^\d{1,15}$/.test(id)) return null;
  const v = ((cfg && cfg.engage && cfg.engage.voiceReply) || {});
  const chats = (Array.isArray(v.chats) ? v.chats : []).map(String);
  const max = Number(v.maxChars);
  return {
    on: v.enabled !== false && chats.includes(id),
    runMode: String(v.runMode || 'small'),
    maxChars: Number.isFinite(max) && max > 0 ? max : 500
  };
}

/**
 * 开 / 关某群的语音伴随（[qqbotb-voicereply:ui-toggle-fn]）。
 *
 * 写 config.engage.voiceReply.chats——开着时本号在本群每发一句文字，都会被
 * 念成日语语音（依田芳乃 · v4.1-Small）发回本群；关掉后下一句起不再念。
 * 不用重启：发送面每次发文字都现读配置。
 *
 * @param {string|number} groupId 群号
 * @param {string} chatKey 会话键
 * @param {boolean} on 是否开启
 * @returns {Promise<void>} 完成
 */
async function toggleVoiceChat(groupId, chatKey, on) {
  const id = String(groupId || '').trim();
  if (!/^\d{1,15}$/.test(id)) { alert('该会话缺少群号，无法设置语音伴随'); return; }
  const cfg = state.config || await api('/api/config');
  const cur = ((((cfg.engage || {}).voiceReply || {}).chats) || []).map(String);
  const next = on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id);
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { voiceReply: { chats: next } } })
    });
    state.config = data.config;
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    renderMemoryList();
  } catch (e) {
    alert(`保存失败：${e.message}`);
  }
}

/** 五档档名（与 config.engage.levels 默认表一致；UI 只作显示，判定在 src 侧）。[qqagent-level-patch:ui-helpers] */
const LEVEL_NAMES = ['冰封', '保守', '标准', '活跃', '全开'];

/** 取某群的档位（未设置 = 3 标准档；返回 null = 该群无法分档）。 */
function engageLevelOf(cfg, groupId) {
  const id = String(groupId || '').trim();
  if (!id) return null;
  const engage = (cfg && cfg.engage) || {};
  const map = engage.levelByChat || {};
  let level = 3;
  if (map[id] != null) {
    const n = Math.round(Number(map[id]));
    if (Number.isFinite(n)) level = Math.min(5, Math.max(1, n));
  } else if ((((engage.quiet || {}).chats) || []).map(String).includes(id)) {
    level = 1;
  }
  return { level, count: LEVEL_NAMES.length, name: LEVEL_NAMES[level - 1] };
}

async function toggleQuietChat(groupId, chatKey) {
  const id = String(groupId || '').trim();
  if (!/^\d{1,15}$/.test(id)) { alert('该会话缺少群号，无法开启安静模式'); return; }
  const cfg = state.config || await api('/api/config');
  const cur = ((cfg.engage && cfg.engage.quiet && cfg.engage.quiet.chats) || []).map(String);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { quiet: { chats: next } } })
    });
    state.config = data.config;
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    renderMemoryList();
  } catch (e) {
    alert(`保存失败：${e.message}`);
  }
}

async function toggleBotMember(qq, chatKey) {
  const id = String(qq || '').trim();
  if (!/^\d{1,15}$/.test(id)) { alert('该群友缺少 QQ 号，无法指定'); return; }
  const cfg = state.config || await api('/api/config');
  const cur = ((cfg.engage && cfg.engage.botGuard && cfg.engage.botGuard.members) || []).map(String);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ engage: { botGuard: { members: next } } })
    });
    state.config = data.config;
    if (state.currentMemoryChatKey === chatKey) await loadMemoryDetail(chatKey);
    if (state.groupMembersLoaded) await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
  } catch (e) {
    alert(`保存失败：${e.message}`);
  }
}

async function loadGroupMembers(chatId, chatKey) {
  const status = $('#mem-members-status');
  if (status) status.textContent = '拉取中…';
  try {
    const data = await api(`/api/groups/${chatId}/members`);
    state.groupMembers = data.members || [];
    state.groupMembersLoaded = true;
    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    // 指定为机器人的群友 QQ（[qqagent-botguard-patch:ui-members-bot-list]）
    const botMembers = ((cfg.engage && cfg.engage.botGuard && cfg.engage.botGuard.members) || []).map(String);
    // 回应参数（群成员表逐人显示）——[qqagent-rapport-patch:ui-members-map]
    let rapportMap = {};
    try {
      const rp = await api(`/api/rapport/${chatKey.replace(':', '_')}`);
      for (const r of (Array.isArray(rp.members) ? rp.members : [])) rapportMap[String(r.userId)] = r;
    } catch { rapportMap = {}; }
    const box = $('#mem-members');
    if (box) {
      box.innerHTML = `<details class="collapsible mem-fold" open><summary><span class="mem-who">群成员（${state.groupMembers.length} 人）</span></summary><div class="coll-body"><table class="member-table">
        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:56px;text-align:right">回应</th><th style="width:90px;text-align:right">备注</th></tr>
        ${state.groupMembers.map((m) => {
          const note = notes[String(m.userId)];
          // 回应参数：0~100，缺省 100（[qqagent-rapport-patch:ui-members-cell]）
          const rp = rapportMap[String(m.userId)];
          const rpScore = rp ? Number(rp.score) : 100;
          const rpTitle = rp ? ('回应参数 ' + rpScore + '/100' + (rp.lastReason ? ' · ' + rp.lastReason : '')) : '回应参数 100/100（初始值）';
          return `<tr>
            <td>${esc(note || m.card || '—')}${note && (m.card || m.nickname) ? ` <span class="muted">(${esc(m.card || m.nickname)})</span>` : ''}</td>
            <td>${esc(m.nickname || '—')}</td>
            <td class="muted" style="font-size:11px">${esc(m.userId)}</td>
            <td style="text-align:right${rpScore < 80 ? ';color:#c0392b' : ''}" title="${esc(rpTitle)}">${rpScore}</td>
            <td style="text-align:right"><button class="btn btn-small member-bot-toggle" data-qq="${esc(m.userId)}" title="指定为机器人：对 TA 的回复限制为 240 秒 1 条">🤖 bot</button> <button class="btn btn-small member-note-edit" data-qq="${esc(m.userId)}">编辑备注</button></td>
          </tr>`;
        }).join('')}
      </table></div></details>`;
      // 🤖 bot 开关（[qqagent-botguard-patch:ui-members-bot-handler]）—— 群成员表里的快捷入口
      box.querySelectorAll('.member-bot-toggle').forEach((el) => {
        const on = botMembers.includes(String(el.dataset.qq));
        el.classList.toggle('btn-primary', on);
        el.textContent = on ? '🤖 bot ✓' : '🤖 bot';
        el.addEventListener('click', () => toggleBotMember(el.dataset.qq, chatKey));
      });
      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });
    }
    if (status) status.textContent = `已拉取 ${state.groupMembers.length} 人`;
  } catch (e) {
    if (status) status.textContent = `拉取失败：${e.message}`;
  }
}

async function openMemberNoteModal(qq, chatKey) {
  const cfg = state.config || await api('/api/config');
  const notes = cfg.memberNotes || {};
  const oldNote = notes[String(qq)] || '';
  const member = (state.groupMembers || []).find((m) => String(m.userId) === String(qq));
  const displayName = member ? String(member.card || member.nickname || '') : '';
  const overlay = modelModalShell({
    head: `编辑备注：${esc(oldNote || displayName || qq)}`,
    body: `
      <div class="field"><label>QQ 号</label><input type="text" value="${esc(qq)}" readonly style="width:100%" /></div>
      <div class="field"><label>备注名</label><input type="text" id="mn-note" value="${esc(oldNote)}" placeholder="${esc(displayName || '备注名（如 老王）')}" style="width:100%" /></div>
      <div class="hint">保存后，聊天记录、记忆、群成员列表都会优先显示这个备注；留空则显示原群名片/昵称。</div>`,
    foot: `<button class="btn" id="mn-cancel">取消</button>
           ${oldNote ? '<button class="btn btn-danger" id="mn-delete">删除备注</button>' : ''}
           <button class="btn btn-primary" id="mn-save">保存</button>`
  });
  overlay.querySelector('#mn-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mn-save').addEventListener('click', async () => {
    const name = $('#mn-note')?.value.trim() || '';
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    if (name) nextNotes[String(qq)] = name; else delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mn-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}
async function loadSettings() {
  const [cfg, tplData, provData, visionData, priceData, toolsData, skillsData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/model-prices').catch(() => ({ prices: [], current: null })),
    api('/api/tools').catch(() => ({ tools: [] })),
    // 技能状态由后端判定（loaded/enabled/available/active + reason），
    // 前端只展示，不自己推断可用性 —— 避免出现第二套口径
    api('/api/skills').catch(() => ({ skills: [], summary: {} }))
  ]);
  state.config = cfg;
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.modelPrices = priceData || { prices: [], current: null };
  state.personaTemplates = {};
  state.toolRegistry = toolsData.tools || [];
  state.skills = skillsData.skills || [];
  state.skillsSummary = skillsData.summary || {};
  state.uninstalledSkills = skillsData.uninstalled || [];
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
  // 提示词预览与配置并行拉取；渲染时可能还没到（先显示占位，到达后原地替换）
  refreshPromptPreview(cfg);
  renderSettings();
}

/** 设置页「远程价格表」状态行：来源（在线/缓存/内置）、时间、条目数、错误。 */
function renderPriceFeedStatus() {
  const el = $('#price-feed-status');
  if (!el) return;
  const r = state.modelPrices?.remote;
  if (!r || !r.enabled) {
    el.textContent = '官网价格表暂未启用，当前使用内置表；点击“拉取价格表”即可立即重试。';
    return;
  }
  const when = r.fetchedAt ? fmtTime(r.fetchedAt) : '-';
  const droppedTxt = r.dropped ? `，${r.dropped} 条不合格被丢弃` : '';
  if (r.ok && r.source === 'remote') {
    el.textContent = `远程表生效中：${r.count} 条覆盖内置表 · 上次拉取 ${when}${droppedTxt}`;
  } else if (!r.ok && r.source === 'cache') {
    el.textContent = `服务器暂时拉不到（${r.error || '未知错误'}），正在用上次缓存的远程表（${r.count} 条）· ${when}`;
  } else if (!r.ok) {
    el.textContent = `拉取失败（${r.error || '未知错误'}），暂用内置表 · ${when}`;
  } else {
    el.textContent = `已应用本地缓存（${r.count} 条），正在拉取最新…`;
  }
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * 匹配判断在本地用 state.modelPrices.prices 直接算，
 * 不读 state.modelPrices.current —— 那是后端按「当时请求的模型」算的，
 * 切换模型后若不重新请求就会拿到旧值。
 */
/**
 * 在内置价格表里匹配模型（前端版）。
 *
 * 前端是无模块单文件，拿不到 src/model-prices.js 的导出，所以这里实现一份
 * 与后端 matchPriceTable 完全相同的逻辑：精确 → 去前缀 → 最长前缀匹配。
 * 用本地数据算而不是读 state.modelPrices.current —— 后者是后端按
 * 「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function refreshModelPriceCard() {
  const modelEl = $('#pc-model');
  const noteEl = $('#pc-note');
  const inEl = $('#cfg-price-in');
  const outEl = $('#cfg-price-out');
  const cachedEl = $('#cfg-price-cached');
  if (!modelEl) return;

  const cfg = state.config || {};
  const api = cfg.api || {};

  // 实时值：优先界面控件，退回已保存配置
  const box = $('#cfg-useofficialprice');
  const modelInput = $('#cfg-model');
  const useOfficial = box ? box.checked : (api.useOfficialPrice !== false);
  const model = String((modelInput ? modelInput.value : api.model) || '').trim();

  modelEl.textContent = model || '（未选择模型）';

  if (!model) {
    [inEl, outEl, cachedEl].forEach((el) => { if (el) { el.value = 0; el.disabled = true; } });
    if (noteEl) noteEl.textContent = '先在上方选择一个模型，才能查看/设定它的单价。';
    return;
  }

  let shown, locked, sourceTxt;

  // 优先级与后端 resolveModelPrice 一致：模型级自定义价命中 > 官方表（开关开）
  // > 全局兜底。曾经开关开时只查官方表 —— 已存自定义价 + 开关开 → 界面显示
  // 官方价、成本看板按自定义价计费，显示与计费两张皮。
  const customEntry = (api.modelPrices || {})[model];
  const hasCustom = !!(customEntry && (Number(customEntry.in) || Number(customEntry.out)));

  if (hasCustom) {
    locked = true;   // 与后端口径对齐：自定义价命中时 locked = useOfficial
    shown = {
      in: Number(customEntry.in) || 0,
      out: Number(customEntry.out) || 0,
      cached: customEntry.cached == null ? Number(customEntry.in) || 0 : Number(customEntry.cached) || 0
    };
    sourceTxt = '正在使用你为该模型设定的单价（优先于官方价格表）。要改请先清除自定义单价。';
  } else if (useOfficial) {
    locked = true;
    const official = matchPriceTable(model, state.modelPrices?.prices || []);
    if (official) {
      shown = {
        in: official.in ?? 0,
        out: official.out ?? 0,
        cached: official.cached == null ? official.in : official.cached
      };
      const tag = official.src === 'official' ? '厂商官方定价页直取' : '二手折算，仅供参考';
      sourceTxt = `内置官方价格表已匹配到「${official.id}」（${tag}）。开关开启时只读 —— 要自定义请关闭上方开关。`;
      if (official.peak) {
        sourceTxt += `　该模型分时段计价（高峰 ${official.peak.in}/${official.peak.out}/${official.peak.cached}）。`;
      }
      if (official.image) {
        sourceTxt += '　支持图片输入：' + (official.image.mode === 'capped'
          ? `每张封顶 ${official.image.maxTokensPerImage} token`
          : official.image.mode === 'pixel'
            ? `每张 = 宽×高/${official.image.divisor}+${official.image.base} token`
            : '换算规则待补');
      }
    } else {
      shown = { in: 0, out: 0, cached: 0 };
      sourceTxt = '';
    }
  } else {
    locked = false;
    shown = {
      in: Number(api.priceInputPerM) || 0,
      out: Number(api.priceOutputPerM) || 0,
      cached: Number(api.priceCachedPerM) || Number(api.priceInputPerM) || 0
    };
    sourceTxt = '已关闭官方价格表，可在此填写该模型的单价（也可在「批量自定义价格编辑」里为多个模型分别设定）。';
  }

  if (inEl) { inEl.value = shown.in ?? 0; inEl.disabled = locked; }
  if (outEl) { outEl.value = shown.out ?? 0; outEl.disabled = locked; }
  if (cachedEl) { cachedEl.value = shown.cached ?? 0; cachedEl.disabled = locked; }
  const card = $('#model-price-card');
  if (card) {
    card.classList.toggle('locked', locked);
    // 官方价开启且无自定义价命中时整卡置灰：视觉上明确「这里不可改」；
    // 命中自定义价时锁定状态由 locked 表达，不额外置灰混淆来源
    card.classList.toggle('pc-official-on', useOfficial === true && !hasCustom);
  }
  if (noteEl) noteEl.textContent = sourceTxt;
}

/**
 * 批量自定义价格编辑：左列选供应商 → 右列该供应商的模型 →
 * 官方表（输入/输出/缓存命中）参考列 + 自定义单价输入列。
 *
 * 曾经的候选列表是"当前模型 + 已自定义 + 用量统计里出现过的" ——
 * 没调用过的模型根本进不了名单，想提前给没用过的新模型定价都做不到。
 * 现在按供应商目录浏览，全量模型都可设定。
 *
 * 两个细节：
 *   1. 编辑暂存在 edits 里（input 事件实时写入），切换供应商不丢未保存的修改
 *   2. 目录之外但已自定义的模型归到虚拟供应商「已自定义（目录外）」，
 *      保证旧条目永远能找到、能清除
 */
function openBatchPriceModal() {
  const cfg = state.config || {};
  const customMap = cfg.api?.modelPrices || {};
  // 编辑暂存：以已保存的自定义价为起点，用户的每一次输入都先落在这里
  const edits = {};
  for (const [k, v] of Object.entries(customMap)) edits[k] = { ...(v || {}) };

  // 左列数据：供应商目录 + 虚拟供应商（目录外已自定义的模型）
  const catalogModels = new Set();
  for (const p of (state.providers || [])) for (const m of (p.models || [])) catalogModels.add(m);
  const orphanCustoms = Object.keys(customMap).filter((k) => !catalogModels.has(k)).sort();
  const lefts = (state.providers || []).map((p) => ({
    id: p.id, name: p.displayName || p.id, models: p.models || [], names: p.modelNames || {}
  }));
  if (orphanCustoms.length) {
    lefts.push({ id: '__custom__', name: `已自定义（目录外 ${orphanCustoms.length}）`, models: orphanCustoms, names: {} });
  }

  if (!lefts.length) {
    modelModalShell({
      head: '批量自定义价格编辑',
      body: '<div class="empty-hint">模型目录为空：请先在「模型 API」页签添加提供商。</div>',
      foot: ''
    });
    return;
  }

  let activePid = lefts[0].id;
  let kw = '';   // 搜索关键词（中转站供应商可能有几百个模型，没搜索没法用）

  const overlay = modelModalShell({
    head: '批量自定义价格编辑',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="bp-search" placeholder="搜索模型…" autocomplete="off" />
        <span class="muted" style="font-size:12px;white-space:nowrap">留空 = 不自定义（走官方表/兜底）</span>
      </div>
      <div class="ma-body dual">
        <div class="model-modal-left" id="bp-left"></div>
        <div class="model-modal-right" id="bp-right"></div>
      </div>
      <div id="bp-hint" class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        输入框占位符与模型名悬停提示均为官方价（元/百万 token）；修改只写入你的配置，不会改动官方价格表。
      </div>`,
    foot: `<button class="btn" id="bp-cancel">取消</button>
           <button class="btn btn-primary" id="bp-save">保存</button>`
  });

  const left = overlay.querySelector('#bp-left');
  const right = overlay.querySelector('#bp-right');
  const hintEl = overlay.querySelector('#bp-hint');

  function renderLeft() {
    left.innerHTML = lefts.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.name)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }

  function rowHtml(p, m) {
    if (kw && !m.toLowerCase().includes(kw) && !String(p.names[m] || '').toLowerCase().includes(kw)) return '';
    const off = matchPriceTable(m, state.modelPrices?.prices || []);
    const c = edits[m] || {};
    // 官方价不占列（太挤）：placeholder 里有，模型名悬停也有
    const offTitle = off ? `官方价：输入 ${off.in} / 输出 ${off.out} / 缓存 ${off.cached ?? '—'}（元/百万）` : '官方价格表未收录';
    return `
      <tr data-model="${esc(m)}">
        <td title="${esc(offTitle)}">${esc(p.names[m] || m)}<div class="muted" style="font-size:11px">${esc(m)}</div></td>
        <td><input type="number" step="0.01" min="0" class="bp-in" value="${esc(c.in ?? '')}" placeholder="${off ? off.in : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-out" value="${esc(c.out ?? '')}" placeholder="${off ? off.out : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-cached" value="${esc(c.cached ?? '')}" placeholder="${off ? (off.cached ?? 0) : 0}" /></td>
        <td><button class="bp-del" title="清除该模型的自定义价">清除</button></td>
      </tr>`;
  }

  function renderRight() {
    const p = lefts.find((x) => x.id === activePid);
    const models = p ? p.models : [];
    right.innerHTML = `
      <table class="usage-table">
        <thead><tr>
          <th>模型（悬停看官方价）</th>
          <th>自定义 输入</th><th>自定义 输出</th><th>自定义 缓存命中</th><th></th>
        </tr></thead>
        <tbody id="bp-body">
          ${models.map((m) => rowHtml(p, m)).join('') || '<tr><td colspan="5" class="muted">没有匹配的模型</td></tr>'}
        </tbody>
      </table>`;
    // 输入实时落进 edits：切换供应商/搜索重渲染后不丢未保存的修改
    right.querySelectorAll('#bp-body tr[data-model]').forEach((tr) => {
      const m = tr.dataset.model;
      const sync = () => {
        const num = (sel) => {
          const v = String(tr.querySelector(sel)?.value ?? '').trim();
          return v === '' ? null : (Number(v) || 0);
        };
        const i = num('.bp-in'), o = num('.bp-out'), c = num('.bp-cached');
        if (i === null && o === null && c === null) delete edits[m];
        else edits[m] = { in: i ?? 0, out: o ?? 0, cached: c ?? (i ?? 0) };
      };
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', sync));
    });
    right.querySelectorAll('#bp-body .bp-del').forEach((el) => {
      el.addEventListener('click', () => {
        const tr = el.closest('tr[data-model]');
        if (!tr) return;
        delete edits[tr.dataset.model];
        tr.querySelectorAll('input').forEach((i) => { i.value = ''; });
      });
    });
  }

  overlay.querySelector('#bp-search')?.addEventListener('input', (e) => {
    kw = String(e.target.value || '').trim().toLowerCase();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#bp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bp-save').addEventListener('click', async () => {
    // 保存的就是 edits 本身（输入时已实时同步，不用再扫 DOM）
    const next = edits;
    try {
      hintEl.textContent = '保存中…';
      // 用 __replace__ 整体替换：普通深合并传对象是删不掉旧键的，
      // 用户点"清除"某行后保存，旧条目会复活。
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ api: { modelPrices: { __replace__: next } } })
      });
      // 更新本地状态，避免下次打开还是旧值
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = next;
      closeModelModal(overlay);
      refreshModelPriceCard();
      // 2026-09-19（M9 清理）：旧 #provider-action-hint 元素已随改版消失，写它会在
      // try 里抛 TypeError 被自己的 catch 吞成"保存失败"。改写存活的 #provider-hint。
      $('#provider-hint').textContent = `已保存 ${Object.keys(next).length} 个模型的自定义单价。`;
    } catch (e) {
      hintEl.textContent = `保存失败：${esc(e.message)}`;
    }
  });
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input type="text" id="cfg-persona-pick" class="inp persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;min-width:160px;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderHealthCard() {
  const { ready, checks } = assessReadiness(state.config, state.status);
  const rows = checks.map((c, idx) => {
    let extra = '';
    if (!c.ok) {
      if (c.fix === 'snowluma-tab') {
        extra = ' <button class="btn btn-small hc-fix-btn" data-target="snowluma">前往启动</button>';
      } else if (c.fix === 'settings-api') {
        extra = ' <button class="btn btn-small hc-fix-btn" data-target="settings-api">去填写</button>';
      } else if (c.fix === 'settings-allow') {
        extra = ' <button class="btn btn-small hc-fix-btn" data-target="settings-allow">去勾选</button>';
      }
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）
