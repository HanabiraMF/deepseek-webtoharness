const { resolveWsPath } = require('./_workspace');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const V = (a, k) => {
    if (!a) return '';
    if (a[k] != null && a[k] !== '') return String(a[k]);
    const ex = a.extraArgs || {};
    if (ex[k] != null && ex[k] !== '') return String(ex[k]);
    const lower = k.toLowerCase();
    for (const key of Object.keys(ex)) { if (key.toLowerCase() === lower && ex[key] != null) return String(ex[key]); }
    if (ex.toolcall) {
        const m = String(ex.toolcall).match(new RegExp('<' + k + '>([\\s\\S]*?)<\\/' + k + '>', 'i'));
        if (m) { let v = m[1]; const c = v.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/); if (c) v = c[1]; return v.trim(); }
    }
    return '';
};

const MAX_FILES = 300;
const SKIP_DIRS = ['node_modules', '.git', '__pycache__', 'dist', 'build', '.venv', 'venv'];
const JS_EXT = ['.js', '.mjs', '.cjs'];

function collect(root, list, depth) {
    if (depth > 8 || list.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
        if (list.length >= MAX_FILES) return;
        if (SKIP_DIRS.includes(ent.name)) continue;
        const full = path.join(root, ent.name);
        if (ent.isDirectory()) collect(full, list, depth + 1);
        else list.push(full);
    }
}

function firstLines(s, n) {
    return String(s || '').split(/\r?\n/).filter(l => l.trim()).slice(0, n || 6).join('\n');
}

function checkJs(abs) {
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0) return { ok: true };
    const msg = firstLines((r.stderr || '') + '\n' + (r.stdout || ''), 6);
    return { ok: false, msg: msg || 'node --check 失败（退出码 ' + r.status + '）' };
}

function checkPy(abs) {
    for (const py of ['python', 'python3']) {
        const r = spawnSync(py, ['-m', 'py_compile', abs], { encoding: 'utf8', timeout: 20000 });
        if (r.error) continue;
        if (r.status === 0) return { ok: true };
        const msg = firstLines((r.stderr || '') + '\n' + (r.stdout || ''), 8);
        return { ok: false, msg: msg || 'python 语法错误' };
    }
    return { ok: null, msg: '未找到 python，已跳过' };
}

function checkFile(abs) {
    const ext = path.extname(abs).toLowerCase();
    if (JS_EXT.includes(ext)) return checkJs(abs);
    if (ext === '.json') {
        try { JSON.parse(fs.readFileSync(abs, 'utf8')); return { ok: true }; }
        catch (e) { return { ok: false, msg: 'JSON 解析失败: ' + e.message }; }
    }
    if (ext === '.py') return checkPy(abs);
    return { ok: null };
}

module.exports = {
    name: 'syntax_check',
    description: "批量检查文件语法错误（js / json / py）",
    params: [
        { k: "path", cn: "路径", req: true, d: "文件或目录，逗号分隔" },
        { k: "ext", cn: "扩展名", req: false, d: "如 .js,.py" }
    ],
    execute: async (args) => {
        const targets = V(args, 'path') || V(args, 'paths') || V(args, 'target') || V(args, 'dir');
        const extFilter = V(args, 'ext');
        if (!targets) return '错误：缺少 path（文件或目录，多个用逗号分隔）';

        const ws = await resolveWsPath('');
        const extList = extFilter
            ? extFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).map(s => (s.startsWith('.') ? s : '.' + s))
            : null;

        const files = [];
        for (const t of targets.split(',').map(s => s.trim()).filter(Boolean)) {
            const abs = await resolveWsPath(t);
            if (!fs.existsSync(abs)) return '错误：路径不存在 ' + t;
            let st;
            try { st = fs.statSync(abs); } catch (e) { return '错误：无法读取 ' + t + ' ' + e.message; }
            if (st.isDirectory()) collect(abs, files, 0);
            else files.push(abs);
        }

        const lines = [];
        let okCount = 0, failCount = 0, skipCount = 0, checked = 0;
        for (const f of files) {
            const ext = path.extname(f).toLowerCase();
            if (extList && !extList.includes(ext)) continue;
            if (!JS_EXT.includes(ext) && ext !== '.json' && ext !== '.py') continue;
            checked++;
            const rel = path.relative(ws, f) || f;
            const r = checkFile(f);
            if (r.ok === null) { skipCount++; lines.push('⏭️  跳过  ' + rel + (r.msg ? '  (' + r.msg + ')' : '')); }
            else if (r.ok) { okCount++; lines.push('✅ 通过  ' + rel); }
            else {
                failCount++;
                lines.push('❌ 失败  ' + rel + '\n' + r.msg.split('\n').map(l => '      ' + l).join('\n'));
            }
            if (lines.length > 400) { lines.push('...（结果过多，已截断）'); break; }
        }

        if (!checked) return '没有可检查的文件（支持 .js/.mjs/.cjs/.json/.py）';
        const head = `语法检查：通过 ${okCount} / 失败 ${failCount} / 跳过 ${skipCount}，共 ${checked} 个文件`;
        return head + '\n' + lines.join('\n');
    }
};
