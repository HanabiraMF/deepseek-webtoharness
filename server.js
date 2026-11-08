const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname, 'plugins');
let serverPlugins = {}; // { name: { description, execute } }

// 确保插件目录存在
if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
}

function loadServerPlugins() {
    serverPlugins = {};
    try {
        const files = fs.readdirSync(PLUGINS_DIR);
        for (const file of files) {
            if (file.endsWith('.js')) {
                try {
                    delete require.cache[require.resolve(path.join(PLUGINS_DIR, file))];
                    const plugin = require(path.join(PLUGINS_DIR, file));
                    if (plugin && plugin.name && typeof plugin.execute === 'function') {
                        serverPlugins[plugin.name] = plugin;
                    }
                } catch (e) {
                    console.error(`加载插件 ${file} 失败:`, e.message);
                }
            }
        }
        console.log(`已加载 ${Object.keys(serverPlugins).length} 个本地服务端插件。`);
    } catch (e) {
        console.error('读取插件目录失败:', e.message);
    }
}
loadServerPlugins();

// ===== 工作区（可变状态）=====
const INIT_WORKSPACE = path.resolve(process.env.DS_AGENT_WORKSPACE || process.cwd());
let WORKSPACE = INIT_WORKSPACE;

function setWorkspace(p) {
    if (!p || typeof p !== 'string') throw new Error('工作区路径为空');
    const abs = path.resolve(p);
    const st = fs.statSync(abs); // 不存在会抛错
    if (!st.isDirectory()) throw new Error('不是目录: ' + abs);
    WORKSPACE = abs;
    console.log(`[工作区] 已切换 -> ${WORKSPACE}`);
    return WORKSPACE;
}

// 弹出系统原生文件夹选择框（Windows 用 PowerShell，macOS 用 osascript）
function pickFolderNative() {
    return new Promise((resolve) => {
        const { execFile } = require('child_process');
        if (process.platform === 'win32') {
            const os = require('os');
            const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.ValidateNames = $false
$f.CheckFileExists = $false
$f.CheckPathExists = $true
$f.FileName = "点击打开即选中当前文件夹"
$f.Filter = "所有文件 (*.*)|*.*"
$f.Title = "请选择 AI 工作区目录"
if ($f.ShowDialog() -eq 'OK') {
    $path = Split-Path -Path $f.FileName -Parent
    if ($path) { Write-Output $path } else { Write-Output $f.FileName }
}
`;
            const tmpFile = path.join(os.tmpdir(), 'ds_pick_folder_' + Date.now() + '.ps1');
            try { fs.writeFileSync(tmpFile, psScript, 'utf8'); } catch (e) { return resolve({ ok: false, error: e.message }); }
            
            execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
                { timeout: 300000, windowsHide: true },
                (err, stdout) => {
                    try { fs.unlinkSync(tmpFile); } catch {}
                    if (err) return resolve({ ok: false, error: err.message });
                    const p = String(stdout || '').trim();
                    if (!p) return resolve({ ok: false, error: '用户取消或未选择' });
                    resolve({ ok: true, path: p });
                });
        } else if (process.platform === 'darwin') {
            execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "请选择 AI 工作区目录")'],
                { timeout: 300000 },
                (err, stdout) => {
                    if (err) return resolve({ ok: false, error: err.message });
                    const p = String(stdout || '').trim().replace(/\/$/, '');
                    if (!p) return resolve({ ok: false, error: '用户取消' });
                    resolve({ ok: true, path: p });
                });
        } else {
            // Linux: 尝试 zenity / kdialog
            execFile('sh', ['-c', 'command -v zenity >/dev/null && zenity --file-selection --directory --title="请选择 AI 工作区目录" || kdialog --getexistingdirectory ~'],
                { timeout: 300000 },
                (err, stdout) => {
                    if (err) return resolve({ ok: false, error: '未找到图形选择器（zenity/kdialog）' });
                    const p = String(stdout || '').trim();
                    if (!p) return resolve({ ok: false, error: '用户取消' });
                    resolve({ ok: true, path: p });
                });
        }
    });
}

const PORT = parseInt(process.env.DS_AGENT_PORT || '39999', 10);
const MAX_BODY = 1024 * 1024;
const MAX_BUFFER = 10 * 1024 * 1024;
const EXEC_TIMEOUT = 30000;
const FETCH_TIMEOUT = 30000;
const MAX_FETCH_RESP = 10 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set(['https://chat.deepseek.com']);
const TOKEN = process.env.DS_AGENT_TOKEN || crypto.randomBytes(24).toString('hex');
const REQUIRE_TOKEN = process.env.DS_AGENT_ALLOW_NO_TOKEN !== '1';

function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '', size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY) { req.destroy(); return reject(new Error('请求体过大')); }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
function decodeBuffer(buf) {
    if (!buf || buf.length === 0) return '';
    try {
        const s = buf.toString('utf8');
        if (!s.includes('\ufffd')) return s;
    } catch {}
    try { return new TextDecoder('gbk').decode(buf); } catch {}
    return buf.toString('utf8');
}
const checkOrigin = (req) => !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin);
const checkToken = (req) => !REQUIRE_TOKEN || req.headers['x-agent-token'] === TOKEN;

const server = http.createServer(async (req, res) => {
    const reqOrigin = req.headers.origin;
    if (reqOrigin && ALLOWED_ORIGINS.has(reqOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', reqOrigin);
        res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
        if (!checkOrigin(req)) { res.writeHead(403); res.end(); return; }
        res.writeHead(204, {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Token',
            'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
    }
    // 鉴权检查下移到 pathname 解析之后（/workspace 与 /workspace/pick 免 Token）

    let pathname;
    try { pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname; }
    catch { return sendJson(res, 400, { error: 'Bad URL' }); }

    const isPublic = (pathname === '/workspace' || pathname === '/workspace/pick');
    if (!checkOrigin(req) || (!isPublic && !checkToken(req))) return sendJson(res, 403, { error: 'Forbidden' });

    if ((req.method === 'POST' || req.method === 'GET') && pathname === '/workspace') {
        // 只读取当前工作区，不弹框
        return sendJson(res, 200, { cwd: WORKSPACE, base: __dirname });
    }

    if (req.method === 'POST' && pathname === '/workspace/pick') {
        // 弹出系统原生文件夹选择框；用户选定后立即切换工作区
        try {
            const r = await pickFolderNative();
            if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error });
            try {
                const abs = setWorkspace(r.path);
                return sendJson(res, 200, { ok: true, cwd: abs });
            } catch (e) {
                return sendJson(res, 200, { ok: false, error: '所选目录无效: ' + e.message });
            }
        } catch (e) {
            return sendJson(res, 200, { ok: false, error: e.message });
        }
    }

    if (req.method === 'POST' && pathname === '/workspace/set') {
        // 直接指定工作区（备用，例如前端记住上次选择）
        try {
            const { path: p } = JSON.parse(await readBody(req) || '{}');
            const abs = setWorkspace(p);
            return sendJson(res, 200, { ok: true, cwd: abs });
        } catch (e) {
            return sendJson(res, 200, { ok: false, error: e.message });
        }
    }

    if (req.method === 'POST' && pathname === '/fs') {
        try {
            const body = JSON.parse(await readBody(req) || '{}');
            const { op } = body;
            const MAX_FILE = 500 * 1024, MAX_DEPTH = 8, MAX_RESULTS = 200;
            const SKIP_DIRS = new Set(['.git','node_modules','dist','build','venv','.venv','__pycache__','target','.next','out','.idea','.vscode','obj','bin','debug','release']);
            const SKIP_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.ico','.exe','.dll','.so','.dylib','.bin','.pdf','.zip','.tar','.gz','.7z','.resources','.baml','.cache','.pyc','.obj','.pdb','.mp4','.mp3','.woff','.woff2','.ttf']);

            function safe(p) {
                if (p === undefined || p === null || p === '') p = '.';
                const abs = path.resolve(WORKSPACE, String(p));
                const rel = path.relative(WORKSPACE, abs);
                if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) throw new Error('不允许访问工作区外路径: ' + p);
                return abs;
            }
            function relOf(abs) {
                const r = path.relative(WORKSPACE, abs);
                return (r.split(path.sep).join('/')) || '.';
            }
            function isBinaryText(text) {
                const s = text.slice(0, 1000);
                if (s.includes('\0')) return true;
                let n = 0;
                for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 9 || (c > 13 && c < 32)) n++; }
                return n / Math.max(1, s.length) > 0.1;
            }
            function backup(abs) {
                try {
                    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) fs.copyFileSync(abs, abs + '.bak');
                } catch {}
            }
            function ensureDir(abs) { fs.mkdirSync(path.dirname(abs), { recursive: true }); }

            function doListdir(p) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('目录不存在: ' + p);
                if (!fs.statSync(abs).isDirectory()) throw new Error(`"${p}" 是文件不是目录`);
                const items = fs.readdirSync(abs).map(name => {
                    try {
                        const s = fs.statSync(path.join(abs, name));
                        return (s.isDirectory() ? 'd ' : 'f ') + name;
                    } catch { return '? ' + name; }
                });
                return items.length ? items.join('\n') : '(空目录)';
            }
            function doOpenfile(p) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + p);
                if (fs.statSync(abs).isDirectory()) throw new Error(`"${p}" 是目录`);
                const text = fs.readFileSync(abs, 'utf8');
                const truncated = text.length > 8000;
                return `文件 ${p}${truncated ? `（前 8000 字符，共 ${text.length}）` : ''}:\n\`\`\`\n${text.slice(0, 8000)}\n\`\`\``;
            }
            function doRead(p) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + p);
                if (fs.statSync(abs).isDirectory()) throw new Error('是目录');
                return fs.readFileSync(abs, 'utf8');
            }
            function doWritefile(p, content) {
                const abs = safe(p);
                if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new Error(`"${p}" 是目录，不能写入`);
                ensureDir(abs);
                backup(abs);
                fs.writeFileSync(abs, content, 'utf8');
                return `${p} 写入成功 (${content.length} 字符)`;
            }
            function doMkdir(p) {
                fs.mkdirSync(safe(p), { recursive: true });
                return `已创建目录: ${p}`;
            }
            function doAppend(p, content) {
                const abs = safe(p);
                ensureDir(abs);
                backup(abs);
                fs.appendFileSync(abs, content, 'utf8');
                return `追加成功: ${p}`;
            }
            function doDel(p) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('路径不存在: ' + p);
                const isDir = fs.statSync(abs).isDirectory();
                fs.rmSync(abs, { recursive: isDir, force: true });
                return `已删除 ${isDir ? '目录' : '文件'}: ${p}`;
            }
            function doMove(from, to) {
                const srcAbs = safe(from);
                if (!fs.existsSync(srcAbs)) throw new Error('源路径不存在: ' + from);
                let dstAbs = safe(to);
                if (fs.existsSync(dstAbs) && fs.statSync(dstAbs).isDirectory()) {
                    dstAbs = path.join(dstAbs, path.basename(srcAbs));
                }
                if (fs.existsSync(dstAbs)) throw new Error('目标已存在: ' + relOf(dstAbs));
                ensureDir(dstAbs);
                fs.renameSync(srcAbs, dstAbs);
                return `已移动 ${from} → ${relOf(dstAbs)}`;
            }
            function doCopy(from, to) {
                const srcAbs = safe(from);
                if (!fs.existsSync(srcAbs)) throw new Error('源路径不存在: ' + from);
                let dstAbs = safe(to);
                if (fs.existsSync(dstAbs) && fs.statSync(dstAbs).isDirectory()) {
                    dstAbs = path.join(dstAbs, path.basename(srcAbs));
                }
                if (fs.existsSync(dstAbs)) throw new Error('目标已存在: ' + relOf(dstAbs));
                ensureDir(dstAbs);
                if (fs.statSync(srcAbs).isDirectory()) fs.cpSync(srcAbs, dstAbs, { recursive: true });
                else fs.copyFileSync(srcAbs, dstAbs);
                return `已复制 ${from} → ${relOf(dstAbs)}`;
            }
            function doEdit(p, oldStr, newStr) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + p);
                const original = fs.readFileSync(abs, 'utf8');
                const firstIdx = original.indexOf(oldStr);
                if (firstIdx === -1) throw new Error('old 块在文件中未找到（注意缩进、空白、换行符）');
                const secondIdx = original.indexOf(oldStr, firstIdx + 1);
                if (secondIdx !== -1) throw new Error('old 出现多次，不唯一，请在 old 中增加上下文');
                const lineNo = original.slice(0, firstIdx).split('\n').length;
                backup(abs);
                fs.writeFileSync(abs, original.slice(0, firstIdx) + newStr + original.slice(firstIdx + oldStr.length), 'utf8');
                return `替换成功（第 ${lineNo} 行，${oldStr.length} 字符 → ${newStr.length} 字符）`;
            }
            function doEditline(p, line, mode, content) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + p);
                const lines = fs.readFileSync(abs, 'utf8').split('\n');
                const idx = line - 1;
                if (mode === 'replace') lines[idx] = content;
                else if (mode === 'insert') lines.splice(idx, 0, content);
                else if (mode === 'delete') lines.splice(idx, 1);
                else throw new Error('mode 必须为 replace/insert/delete');
                backup(abs);
                fs.writeFileSync(abs, lines.join('\n'), 'utf8');
                return `已执行 ${mode} (第 ${line} 行)`;
            }
            function doReplaceall(target, find, replace) {
                const abs = safe(target || '.');
                if (!fs.existsSync(abs)) throw new Error('目标不存在: ' + target);
                let files = 0, count = 0;
                function processFile(p) {
                    if (/\.bak$/i.test(p)) return;
                    let text;
                    try {
                        const st = fs.statSync(p);
                        if (!st.isFile() || st.size > MAX_FILE) return;
                        text = fs.readFileSync(p, 'utf8');
                    } catch { return; }
                    if (isBinaryText(text)) return;
                    const parts = text.split(find);
                    const c = parts.length - 1;
                    if (c === 0) return;
                    backup(p);
                    fs.writeFileSync(p, parts.join(replace), 'utf8');
                    files++; count += c;
                }
                function walk(dir, depth) {
                    if (depth > MAX_DEPTH) return;
                    let names; try { names = fs.readdirSync(dir); } catch { return; }
                    for (const name of names) {
                        const full = path.join(dir, name);
                        let st; try { st = fs.statSync(full); } catch { continue; }
                        if (st.isDirectory()) {
                            if (SKIP_DIRS.has(name.toLowerCase())) continue;
                            walk(full, depth + 1);
                        } else {
                            const ext = '.' + name.split('.').pop().toLowerCase();
                            if (SKIP_EXTS.has(ext)) continue;
                            processFile(full);
                        }
                    }
                }
                if (fs.statSync(abs).isDirectory()) walk(abs, 0); else processFile(abs);
                return `批量替换完成：${files} 个文件，共 ${count} 处`;
            }
            function doGrep(pattern, rootP) {
                let re;
                try { re = new RegExp(pattern, 'i'); } catch (e) { throw new Error('正则无效: ' + e.message); }
                const abs = safe(rootP || '.');
                if (!fs.existsSync(abs)) throw new Error('路径不存在: ' + rootP);
                const results = [];
                if (fs.statSync(abs).isFile()) {
                    const text = fs.readFileSync(abs, 'utf8');
                    if (!isBinaryText(text)) {
                        text.split('\n').forEach((line, i) => {
                            if (results.length >= MAX_RESULTS) return;
                            if (re.test(line)) results.push(`${relOf(abs)}:${i+1}: ${line.trim().slice(0,200)}`);
                        });
                    }
                } else {
                    (function walk(dir, depth) {
                        if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;
                        let names; try { names = fs.readdirSync(dir); } catch { return; }
                        for (const name of names) {
                            if (results.length >= MAX_RESULTS) return;
                            const full = path.join(dir, name);
                            let s; try { s = fs.statSync(full); } catch { continue; }
                            if (s.isDirectory()) {
                                if (SKIP_DIRS.has(name.toLowerCase())) continue;
                                walk(full, depth + 1);
                            } else {
                                const ext = '.' + name.split('.').pop().toLowerCase();
                                if (SKIP_EXTS.has(ext) || s.size > MAX_FILE) continue;
                                try {
                                    const text = fs.readFileSync(full, 'utf8');
                                    if (isBinaryText(text)) continue;
                                    text.split('\n').forEach((line, i) => {
                                        if (results.length >= MAX_RESULTS) return;
                                        if (re.test(line)) results.push(`${relOf(full)}:${i+1}: ${line.trim().slice(0,200)}`);
                                    });
                                } catch {}
                            }
                        }
                    })(abs, 0);
                }
                const suffix = results.length >= MAX_RESULTS ? '\n...(已达上限，请缩小范围)' : '';
                return results.length ? results.join('\n') + suffix : '(无匹配)';
            }
            function globToRegex(pattern) {
                const parts = pattern.replace(/\\/g, '/').split('/');
                let re = '';
                for (let i = 0; i < parts.length; i++) {
                    const seg = parts[i];
                    if (seg === '**') re += (i === parts.length - 1) ? '.*' : '(?:.*\\/)?';
                    else {
                        re += seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
                        if (i < parts.length - 1) re += '\\/';
                    }
                }
                return new RegExp('^' + re + '$');
            }
            function doGlob(pattern) {
                const re = globToRegex(pattern);
                const results = [];
                (function walk(dir, prefix, depth) {
                    if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;
                    let names; try { names = fs.readdirSync(dir); } catch { return; }
                    for (const name of names) {
                        if (results.length >= MAX_RESULTS) return;
                        const full = path.join(dir, name);
                        const rel = prefix ? `${prefix}/${name}` : name;
                        let s; try { s = fs.statSync(full); } catch { continue; }
                        if (s.isDirectory()) {
                            if (SKIP_DIRS.has(name.toLowerCase())) continue;
                            walk(full, rel, depth + 1);
                        } else if (re.test(rel)) results.push(rel);
                    }
                })(safe('.'), '', 0);
                const suffix = results.length >= MAX_RESULTS ? '\n...(已达上限)' : '';
                return results.length ? results.join('\n') + suffix : '(无匹配)';
            }
            function doStat(p) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('路径不存在: ' + p);
                const st = fs.statSync(abs);
                if (st.isDirectory()) return `类型: 目录\n路径: ${p}`;
                return `类型: 文件\n路径: ${p}\n大小: ${(st.size/1024).toFixed(2)} KB (${st.size} 字节)\n修改时间: ${new Date(st.mtimeMs).toLocaleString()}`;
            }
            function doDiff(p1, p2) {
                const t1 = doRead(p1), t2 = doRead(p2);
                const l1 = t1.split('\n'), l2 = t2.split('\n');
                let out = `--- ${p1}\n+++ ${p2}\n`;
                let diffs = 0;
                const max = Math.max(l1.length, l2.length);
                for (let i = 0; i < max; i++) {
                    if (l1[i] !== l2[i]) {
                        if (l1[i] !== undefined) out += `- ${l1[i]}\n`;
                        if (l2[i] !== undefined) out += `+ ${l2[i]}\n`;
                        diffs++;
                        if (diffs > 100) { out += '... (差异过多，已截断)'; break; }
                    }
                }
                return diffs === 0 ? '两文件内容完全一致' : out;
            }
            function doHash(p) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + p);
                const buf = fs.readFileSync(abs);
                return `SHA-256: ${crypto.createHash('sha256').update(buf).digest('hex')}\n大小: ${buf.length} 字节`;
            }

            let result;
            switch (op) {
                case 'listdir': result = doListdir(body.path || '.'); break;
                case 'openfile': result = doOpenfile(body.path); break;
                case 'read': result = doRead(body.path); break;
                case 'mkdir': result = doMkdir(body.path); break;
                case 'writefile': result = doWritefile(body.path, body.content); break;
                case 'append': result = doAppend(body.path, body.content); break;
                case 'del': result = doDel(body.path); break;
                case 'move': result = doMove(body.from, body.to); break;
                case 'copy': result = doCopy(body.from, body.to); break;
                case 'edit': result = doEdit(body.path, body.old, body.new); break;
                case 'editline': result = doEditline(body.path, parseInt(body.line, 10), body.mode, body.content); break;
                case 'replaceall': result = doReplaceall(body.path || '.', body.find, body.replace); break;
                case 'grep': result = doGrep(body.pattern, body.path || '.'); break;
                case 'glob': result = doGlob(body.pattern); break;
                case 'stat': result = doStat(body.path); break;
                case 'diff': result = doDiff(body.path1, body.path2); break;
                case 'hash': result = doHash(body.path); break;
                case 'readb64': {
                    const absB = safe(body.path);
                    if (!fs.existsSync(absB)) throw new Error('文件不存在: ' + body.path);
                    const ext = path.extname(absB).toLowerCase();
                    const mimeMap = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp','.ico':'image/x-icon' };
                    const mime = mimeMap[ext] || 'application/octet-stream';
                    result = 'data:' + mime + ';base64,' + fs.readFileSync(absB).toString('base64');
                    break;
                }
                default: return sendJson(res, 400, { ok: false, error: '未知 op: ' + op });
            }
            return sendJson(res, 200, { ok: true, result: String(result) });
        } catch (e) {
            return sendJson(res, 200, { ok: false, error: e.message });
        }
    }

    if ((req.method === 'POST' || req.method === 'GET') && pathname === '/plugins/list') {
        const list = Object.values(serverPlugins).map(p => ({ name: p.name, description: p.description }));
        return sendJson(res, 200, { plugins: list });
    }

    if (req.method === 'POST' && pathname === '/plugins/reload') {
        loadServerPlugins();
        const list = Object.values(serverPlugins).map(p => ({ name: p.name, description: p.description }));
        return sendJson(res, 200, { success: true, plugins: list });
    }

    if (req.method === 'POST' && pathname === '/plugins/exec') {
        try {
            const { name, args } = JSON.parse(await readBody(req) || '{}');
            if (!name || !serverPlugins[name]) {
                return sendJson(res, 404, { error: `服务端插件不存在: ${name}` });
            }
            Promise.resolve(serverPlugins[name].execute(args))
                .then(result => sendJson(res, 200, { result: String(result) }))
                .catch(err => sendJson(res, 200, { error: err.message || String(err) }));
        } catch (e) {
            sendJson(res, 400, { error: e.message });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/exec') {
        try {
            const { command, cwd, timeout = 30000 } = JSON.parse(await readBody(req) || '{}');
            if (typeof command !== 'string' || !command.trim())
                return sendJson(res, 400, { error: '缺少 command' });

            let workDir = WORKSPACE;
            if (typeof cwd === 'string' && cwd.trim()) {
                const c = path.resolve(WORKSPACE, cwd.trim());
                let st = null;
                try { st = fs.statSync(c); } catch {}
                if (st && st.isDirectory()) workDir = c;
                else console.warn(`[exec] cwd 无效，已回落到工作区: ${cwd} -> ${WORKSPACE}`);
            }

            const isWin = process.platform === 'win32';
            const shell = isWin ? 'cmd.exe' : '/bin/sh';
            const args = isWin ? ['/c', `chcp 65001 >nul && ${command}`] : ['-c', command];
            
            const child = require('child_process').spawn(shell, args, { cwd: workDir, windowsHide: true });
            
            let output = '';
            let killedByTimeout = false;
            let responded = false;

            const sendResponse = (exitCode, msg = '') => {
                if (responded) return;
                responded = true;
                sendJson(res, 200, { output: output + msg, exitCode, pid: child.pid });
            };

            child.stdout.on('data', d => output += d.toString('utf8'));
            child.stderr.on('data', d => output += d.toString('utf8'));
            
            child.on('close', code => {
                if (!killedByTimeout) sendResponse(code === null ? 1 : code);
            });
            
            child.on('error', err => {
                sendResponse(1, `\n[启动失败] ${err.message}`);
            });

            setTimeout(() => {
                if (!responded) {
                    killedByTimeout = true;
                    sendResponse(0, `\n[进程运行超过 ${timeout/1000} 秒，已转入后台运行。PID: ${child.pid}。如果觉得卡死，可使用 kill_process 终止]`);
                }
            }, parseInt(timeout, 10));
            
        } catch (e) { sendJson(res, 400, { error: e.message }); }
        return;
    }

    if (req.method === 'POST' && pathname === '/exec/kill') {
        try {
            const { pid } = JSON.parse(await readBody(req) || '{}');
            if (!pid) return sendJson(res, 400, { error: '缺少 pid' });
            
            if (process.platform === 'win32') {
                require('child_process').exec(`taskkill /F /PID ${pid} /T`, (err, stdout, stderr) => {
                    sendJson(res, 200, { output: `进程 ${pid} 已被强制终止。\n${stdout}\n${stderr}`, exitCode: 0 });
                });
            } else {
                require('child_process').exec(`kill -9 ${pid}`, (err, stdout, stderr) => {
                    sendJson(res, 200, { output: `进程 ${pid} 已被强制终止。\n${stdout}\n${stderr}`, exitCode: 0 });
                });
            }
        } catch (e) { sendJson(res, 400, { error: e.message }); }
        return;
    }

    if (req.method === 'POST' && pathname === '/fetch') {
        try {
            const { url, method = 'GET', content, headers = {} } = JSON.parse(await readBody(req) || '{}');
            if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
                return sendJson(res, 400, { error: 'url 必须是 http:// 或 https:// 地址' });
            const m = String(method).toUpperCase();
            if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m))
                return sendJson(res, 400, { error: `不支持的 method: ${m}` });

            const result = await new Promise((resolve, reject) => {
                const lib = url.startsWith('https') ? require('https') : require('http');
                let u;
                try { u = new URL(url); } catch { return reject(new Error('URL 解析失败')); }
                const options = { method: m, headers: {} };

                if (headers && typeof headers === 'object') {
                    for (const [k, v] of Object.entries(headers)) options.headers[k] = String(v);
                }

                let bodyBuf = null;
                if (content !== undefined && content !== null && m !== 'GET' && m !== 'HEAD') {
                    bodyBuf = Buffer.from(String(content), 'utf8');
                    if (!options.headers['Content-Type']) {
                        options.headers['Content-Type'] = 'text/plain; charset=utf-8';
                    }
                    options.headers['Content-Length'] = bodyBuf.length;
                }
                const r = lib.request(u, options, (resp) => {
                    const chunks = [];
                    let size = 0;
                    resp.on('data', c => {
                        size += c.length;
                        if (size > MAX_FETCH_RESP) { resp.destroy(); reject(new Error('响应体超过 10MB 上限')); return; }
                        chunks.push(c);
                    });
                    resp.on('end', () => resolve({
                        status: resp.statusCode,
                        statusText: resp.statusMessage || '',
                        text: Buffer.concat(chunks).toString('utf8'),
                    }));
                    resp.on('error', reject);
                });
                r.setTimeout(FETCH_TIMEOUT, () => r.destroy(new Error(`请求超时（${FETCH_TIMEOUT/1000}s）`)));
                r.on('error', reject);
                if (bodyBuf) r.write(bodyBuf);
                r.end();
            });
            sendJson(res, 200, result);
        } catch (e) {
            sendJson(res, 502, { error: e.message, hint: '检查目标地址是否可达、是否 http(s)、DNS 是否正常' });
        }
        return;
    }

    sendJson(res, 404, { error: 'Not Found' });
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 被占用，设置 DS_AGENT_PORT 换端口`);
    else console.error(e);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`CMD 服务已启动: http://127.0.0.1:${PORT}`);
    if (REQUIRE_TOKEN) {
        console.log('==============================================');
        console.log(' 访问 Token（粘贴到插件面板，仅需一次）:');
        console.log(' ' + TOKEN);
        console.log(' 禁用校验：set DS_AGENT_ALLOW_NO_TOKEN=1');
        console.log('==============================================');
    }
});