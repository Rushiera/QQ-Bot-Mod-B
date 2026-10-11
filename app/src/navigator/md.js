// ═══════════════════════════════════════════
// lib/md.js —— 手写 Markdown 渲染器
// 来源：chat-md.js 全文（F3——MD 真实渲染）
// 定位：纯函数，无 DOM 依赖，输出受控 HTML 字符串（自控标签 + 全文本转义 = 无 XSS，不需 DOMPurify）
// 语法子集：代码块 / 标题 / 引用 / 任务列表 / 无序有序列表 / 表格 / 水平线 + 行内 **bold** *italic* `code`
// 取舍：原样保留（已是合格素材形态）
// ═══════════════════════════════════════════

// 行内标记扫描正则——** 优先于 *（交替顺序即优先级）；g 标志 + lastIndex 手动控制（递归重入安全：每轮重设）
var MD_INLINE_MARK = /(\*\*|\*|`)/g;

function mdEscapeHtml(s) {
    // 文本安全转义——MD 渲染唯一转义入口（XSS 防御：所有用户文本必须先过此函数）
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mdEscapeAttr(s) {
    // 属性值转义——mdEscapeHtml 基础上把换行转为 &#10;（属性值单行化；DOM getAttribute 解码回 LF）
    return mdEscapeHtml(s).replace(/\n/g, '&#10;');
}

function mdParseInline(text) {
    // 行内解析——**粗体** / *斜体* / `代码`；未闭合标记按原文输出；内层递归（粗体内可含代码）
    var out = '';
    var pos = 0;
    var n = text.length;
    while (pos < n) {
        // 标记扫描——单正则线性推进（三连 indexOf 在超长回复 + 深嵌套下退化 O(n²)）
        MD_INLINE_MARK.lastIndex = pos;
        var m = MD_INLINE_MARK.exec(text);
        var next = (m === null) ? -1 : m.index;
        var kind = (m === null) ? '' : m[1];
        if (next < 0) {
            out += mdEscapeHtml(text.substring(pos));
            break;
        }
        if (next > pos) {
            out += mdEscapeHtml(text.substring(pos, next));
        }
        var end = text.indexOf(kind, next + kind.length);
        if (end < 0) {
            // 未闭合标记——从标记处原样输出（前缀 [pos,next) 已输出；从 pos 重出会重复文本）
            out += mdEscapeHtml(text.substring(next));
            break;
        }
        var inner = text.substring(next + kind.length, end);
        if (kind === '**') {
            out += '<strong>' + mdParseInline(inner) + '</strong>';
        } else if (kind === '*') {
            out += '<em>' + mdParseInline(inner) + '</em>';
        } else {
            out += '<code>' + mdEscapeHtml(inner) + '</code>';
        }
        pos = end + kind.length;
    }
    return out;
}

function mdIsTableSep(line) {
    // 表格分隔行判定——仅含 | - : 空格（|---| 格式）
    for (var i = 0; i < line.length; i = i + 1) {
        var ch = line[i];
        if (ch !== '|' && ch !== '-' && ch !== ':' && ch !== ' ') { return false; }
    }
    return true;
}

function mdSplitTableCells(line) {
    // 单元格切分——按未转义的 | 分割（GFM 表格约定：\| = 字面量管道）；仅 | 一种转义，其余反斜杠原样保留
    // 行内代码态——`...` 内的 | 不作分隔符（判例 2026-09-29：`.resolution.width|height` 把数据行切成三列）
    var cells = [];
    var cur = '';
    var inCode = false;
    for (var i = 0; i < line.length; i = i + 1) {
        var ch = line[i];
        if (ch === '\\' && i + 1 < line.length && line[i + 1] === '|') {
            cur += '|';
            i = i + 1;
            continue;
        }
        if (ch === '`') {
            inCode = !inCode;
            cur += ch;
            continue;
        }
        if (ch === '|' && !inCode) {
            cells.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    cells.push(cur);
    return cells;
}

function mdRenderTableRow(line) {
    // 单行单元格解析——按未转义的 | 分割（首尾空串剥离），每个单元格走行内解析
    var cells = mdSplitTableCells(line);
    var start = 0;
    var end = cells.length;
    if (cells[0].trim() === '') { start = 1; }
    if (end > start && cells[end - 1].trim() === '') { end = end - 1; }
    var html = '';
    for (var c = start; c < end; c = c + 1) {
        html += '<td>' + mdParseInline(cells[c].trim()) + '</td>';
    }
    return html;
}

function mdRenderTable(rows, hasHeader) {
    // 表格渲染——HTML 真表格：有分隔行 → 首行表头；无 → 全部数据行
    var html = '<table>';
    if (hasHeader && rows.length > 0) {
        html += '<thead><tr>' + mdRenderTableRow(rows[0]) + '</tr></thead>';
        rows = rows.slice(1);
    }
    html += '<tbody>';
    for (var r = 0; r < rows.length; r = r + 1) {
        html += '<tr>' + mdRenderTableRow(rows[r]) + '</tr>';
    }
    html += '</tbody></table>';
    return html;
}

function mdToHtml(md) {
    // 主入口——MD 文本 → 受控 HTML 字符串。空输入返回空串。
    // 分块策略：逐行扫描 + 收集器缓冲（表格/列表/段落按类型聚合，遇新块或空行 flush）
    if (!md) { return ''; }
    var lines = String(md).replace(/\r\n/g, '\n').replace(/\t/g, '    ').split('\n');
    var out = [];
    var i = 0;
    var inCode = false;
    var codeBuf = [];
    var codeLang = '';           // 代码块语言标记（```markdown 递归渲染判定）
    var tableBuf = null;
    var tableSrc = [];           // 表格源行（含分隔行原文——A81 复制用：渲染丢弃分隔行，源文本保留）
    var tableHasHeader = false;
    var listBuf = null;          // { tag:'ul'|'ol', items:[{html, done}] }
    var paraBuf = [];

    function flushPara() {
        if (paraBuf.length > 0) {
            out.push('<p>' + mdParseInline(paraBuf.join('\n')) + '</p>');
            paraBuf = [];
        }
    }
    function flushList() {
        if (!listBuf) { return; }
        var html = '<' + listBuf.tag + '>';
        for (var k = 0; k < listBuf.items.length; k = k + 1) {
            var it = listBuf.items[k];
            if (it.done !== null) {
                html += '<li class="md-task' + (it.done ? ' done' : '') + '">' + it.html + '</li>';
            } else {
                html += '<li>' + it.html + '</li>';
            }
        }
        html += '</' + listBuf.tag + '>';
        out.push(html);
        listBuf = null;
    }
    function flushTable() {
        if (tableBuf && tableBuf.length > 0) {
            // 复制原文——包裹层 = 按钮定位上下文（pre / table 自身是横滚容器，按钮放里面会随内容滚动）
            out.push('<div class="md-copy" data-md="' + mdEscapeAttr(tableSrc.join('\n')) + '">' + mdRenderTable(tableBuf, tableHasHeader) + '</div>');
        }
        tableBuf = null;
        tableSrc = [];
        tableHasHeader = false;
    }

    for (; i < lines.length; i = i + 1) {
        var line = lines[i];
        var t = line.trim();

        // [块1] 代码块——``` 开关；语言标记（```csharp）忽略只取内容
        // 🔴 ```markdown / ```md 代码块 → 递归按 Markdown 渲染（LLM 常用 ```markdown 包表格/标题展示源码效果）
        if (t.indexOf('```') === 0) {
            flushPara(); flushList(); flushTable();
            if (!inCode) {
                inCode = true;
                codeBuf = [];
                codeLang = t.substring(3).trim().toLowerCase();
            } else {
                inCode = false;
                if (codeLang === 'markdown' || codeLang === 'md') {
                    out.push(mdToHtml(codeBuf.join('\n')));
                } else {
                    out.push('<div class="md-copy"><pre><code>' + mdEscapeHtml(codeBuf.join('\n')) + '</code></pre></div>');
                }
            }
            continue;
        }
        if (inCode) { codeBuf.push(line); continue; }

        // [块2] 表格——| 开头缓冲；分隔行标记表头；非表格行 flush
        if (t.length > 0 && t[0] === '|') {
            flushPara(); flushList();
            if (mdIsTableSep(t)) {
                tableHasHeader = (tableBuf !== null && tableBuf.length > 0);
                if (tableBuf !== null) { tableSrc.push(t); }
                continue;
            }
            if (tableBuf === null) { tableBuf = []; tableHasHeader = false; }
            tableBuf.push(t);
            tableSrc.push(t);
            continue;
        }
        if (tableBuf !== null) { flushTable(); }

        // [块3] 标题——#~######（h1-h6；一级标题禁用于对话——但解析保留）
        var hc = 0;
        while (hc < line.length && line[hc] === '#') { hc = hc + 1; }
        if (hc >= 1 && hc <= 6 && hc < line.length && line[hc] === ' ') {
            flushPara(); flushList();
            out.push('<h' + hc + '>' + mdParseInline(line.substring(hc + 1)) + '</h' + hc + '>');
            continue;
        }

        // [块4] 引用——> 前缀
        if (t[0] === '>') {
            flushPara(); flushList();
            out.push('<blockquote>' + mdParseInline(t.substring(1).trim()) + '</blockquote>');
            continue;
        }

        // [块5] 任务列表——- [ ] / - [x]（合并连续列表项）
        var tm = t.match(/^- \[([ xX])\] (.*)$/);
        if (tm) {
            flushPara(); flushTable();
            if (listBuf === null || listBuf.tag !== 'ul') {
                flushList();
                listBuf = { tag: 'ul', items: [] };
            }
            listBuf.items.push({ html: mdParseInline(tm[2]), done: (tm[1].toLowerCase() === 'x') });
            continue;
        }

        // [块6] 无序列表——- / *（** 粗体开头排除）
        if (t.indexOf('- ') === 0 || (t.indexOf('* ') === 0 && t.indexOf('**') !== 0)) {
            flushPara(); flushTable();
            if (listBuf === null || listBuf.tag !== 'ul') {
                flushList();
                listBuf = { tag: 'ul', items: [] };
            }
            listBuf.items.push({ html: mdParseInline(t.substring(2)), done: null });
            continue;
        }

        // [块7] 有序列表——数字. / 数字)
        var om = t.match(/^(\d+)[.)] (.*)$/);
        if (om) {
            flushPara(); flushTable();
            if (listBuf === null || listBuf.tag !== 'ol') {
                flushList();
                listBuf = { tag: 'ol', items: [] };
            }
            listBuf.items.push({ html: mdParseInline(om[2]), done: null });
            continue;
        }

        // 其他行——先 flush 列表（列表结束）
        if (listBuf !== null) { flushList(); }

        // [块8] 水平线——--- / *** / ___
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
            flushPara();
            out.push('<hr>');
            continue;
        }

        // [块9] 普通行——累积段落；空行 flush（GFM 语义：空行 = 段落分隔）
        if (t.length === 0) { flushPara(); continue; }
        paraBuf.push(line);
    }

    // EOF flush 全部收集器
    flushPara(); flushList(); flushTable();
    if (inCode) {
        out.push('<div class="md-copy"><pre><code>' + mdEscapeHtml(codeBuf.join('\n')) + '</code></pre></div>');
    }
    return out.join('\n');
}

// ── QQBotB 侧引入说明 ──
// 本文件为 CH4 前端 md.js 的副本（来源：http://127.0.0.1:<猫端口>/js/chat/lib/md.js?v=<版本>）。
// CH4 前端改渲染器后重新同步覆盖本文件；除末尾导出行外不改动正文——保证与 CH4 渲染结果一致。
export { mdToHtml };
