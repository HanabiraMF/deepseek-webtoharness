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
let isPicking = false; // 文件夹选择框并发锁

function setWorkspace(p) {
    if (!p || typeof p !== 'string') throw new Error('工作区路径为空');
    const abs = path.resolve(p);
    const st = fs.statSync(abs); // 不存在会抛错
    if (!st.isDirectory()) throw new Error('不是目录: ' + abs);
    WORKSPACE = abs;
    console.log(`[工作区] 已切换 -> ${WORKSPACE}`);
    return WORKSPACE;
}

// 临时文件清理（进程退出兜底）
const tmpFilesToClean = new Set();
process.on('exit', () => {
    for (const f of tmpFilesToClean) { try { fs.unlinkSync(f); } catch {} }
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// 弹出系统原生文件夹选择框（Windows 用 PowerShell，macOS 用 osascript）
function pickFolderNative() {
    return new Promise((resolve) => {
        const { execFile } = require('child_process');
        if (process.platform === 'win32') {
            const os = require('os');
            const psScript = `
Add-Type -AssemblyName System.Windows.Forms
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DSFocusHelper {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
} catch {}
$prevWnd = [IntPtr]::Zero
try { $prevWnd = [DSFocusHelper]::GetForegroundWindow() } catch {}
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.ValidateNames = $false
$f.CheckFileExists = $false
$f.CheckPathExists = $true
$f.FileName = "点击打开即选中当前文件夹"
$f.Filter = "所有文件 (*.*)|*.*"
$f.Title = "请选择 AI 工作区目录"
$dlgResult = $f.ShowDialog()
if ($prevWnd -ne [IntPtr]::Zero) {
    try {
        [DSFocusHelper]::ShowWindow($prevWnd, 9) | Out-Null
        [DSFocusHelper]::SetForegroundWindow($prevWnd) | Out-Null
    } catch {}
}
if ($dlgResult -eq [System.Windows.Forms.DialogResult]::OK) {
    $path = Split-Path -Path $f.FileName -Parent
    if ($path) { Write-Output $path } else { Write-Output $f.FileName }
}
`;
            const tmpFile = path.join(os.tmpdir(), 'ds_pick_folder_' + Date.now() + '.ps1');
            // 关键：必须加 UTF-8 BOM，否则 PowerShell 5.1 按 GBK 读取会让中文全部乱码 → 脚本语法错误 → 弹窗根本不出现
            try { fs.writeFileSync(tmpFile, '\uFEFF' + psScript, 'utf8'); tmpFilesToClean.add(tmpFile); }
            catch (e) { return resolve({ ok: false, error: e.message }); }
            
            // 注意：windowsHide 会连同 WinForms 弹窗一起隐藏，必须用 -WindowStyle Hidden 只藏控制台
            execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
                { timeout: 120000, windowsHide: false },
                (err, stdout) => {
                    try { fs.unlinkSync(tmpFile); tmpFilesToClean.delete(tmpFile); } catch {}
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
const checkOrigin = (req) => !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin);
// 严格来源：必须带 Origin 且在白名单内（用于敏感本地操作）
const checkStrictOrigin = (req) => !!req.headers.origin && ALLOWED_ORIGINS.has(req.headers.origin);
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
        // 弹框属于敏感操作：必须来自白名单 Origin，防止本地程序反复触发弹窗
        if (!checkStrictOrigin(req)) return sendJson(res, 403, { error: '仅允许网页端调用弹框' });
        // 并发锁：避免连点弹出多个选择框
        if (isPicking) return sendJson(res, 200, { ok: false, error: '已有一个选择框在等待，请先完成或取消' });
        isPicking = true;
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
        } finally {
            isPicking = false;
        }
    }
    if (req.method === 'POST' && pathname === '/workspace/set') {
        // 直接切换工作区（用于前端"最近工作区"下拉切换）
        if (!checkStrictOrigin(req)) return sendJson(res, 403, { error: '仅允许网页端调用' });
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
            const isBackup = (name) => /\.bak$/i.test(name); // 自动备份文件不进 grep / glob
            // ===== 危险路径保护 + 审计日志 =====
            const WRITE_OPS = new Set(['writefile','append','del','move','copy','edit','editline','replaceall','mkdir','batch']);
            const DANGER_SEGS = ['\\windows\\', '\\program files\\', '\\program files (x86)\\', '\\programdata\\', '\\appdata\\', '\\$recycle.bin\\'];
            function isDangerPath(abs) {
                const norm = (String(abs).replace(/\//g, '\\') + '\\').toLowerCase();
                return DANGER_SEGS.some(s => norm.includes(s));
            }
            function checkDanger(abs, op, force) {
                if (force) return;
                if (!WRITE_OPS.has(op)) return;
                if (isDangerPath(abs)) {
                    throw Object.assign(new Error('危险路径保护：' + abs + ' 位于系统敏感区域（Windows/Program Files/ProgramData/AppData/回收站）。如确需操作，请在 toolcall 中加 <force>true</force> 强制允许。'), { type: '危险路径' });
                }
            }
            function auditLog(op, target, detail) {
                try {
                    const logPath = path.join(WORKSPACE, '.ds_audit.log');
                    const line = '[' + new Date().toISOString() + '] ' + op + ' | ' + target + ' | ' + (detail || '') + '\n';
                    fs.appendFileSync(logPath, line, 'utf8');
                } catch (e) {}
            }

            function safe(p) {
                if (p === undefined || p === null || p === '') p = '.';
                const abs = path.resolve(WORKSPACE, String(p));
                const rel = path.relative(WORKSPACE, abs);
                if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
                    throw Object.assign(new Error('不允许访问工作区外路径: ' + p), { type: '越界' });
                }
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

            function doListdir(p, tree) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('目录不存在: ' + p);
                if (!fs.statSync(abs).isDirectory()) throw new Error(`"${p}" 是文件不是目录`);
                if (tree) {
                    const MAXN = 1000, MAXD = 6;
                    const lines = [];
                    let count = 0;
                    (function walk(dir, prefix, depth) {
                        if (depth > MAXD) return;
                        let names; try { names = fs.readdirSync(dir).sort(); } catch { return; }
                        for (const name of names) {
                            if (count >= MAXN) { lines.push(prefix + '... (已达上限，请缩小范围)'); return; }
                            const full = path.join(dir, name);
                            let s; try { s = fs.statSync(full); } catch { lines.push(prefix + '? ' + name); count++; continue; }
                            if (s.isDirectory()) {
                                if (SKIP_DIRS.has(name.toLowerCase())) { lines.push(prefix + 'd ' + name + '/ (已跳过)'); count++; continue; }
                                lines.push(prefix + 'd ' + name + '/');
                                count++;
                                walk(full, prefix + '  ', depth + 1);
                            } else {
                                lines.push(prefix + 'f ' + name);
                                count++;
                            }
                        }
                    })(abs, '', 0);
                    return `目录树 ${p}:\n` + (lines.length ? lines.join('\n') : '(空目录)');
                }
                const items = fs.readdirSync(abs).map(name => {
                    try {
                        const s = fs.statSync(path.join(abs, name));
                        return (s.isDirectory() ? 'd ' : 'f ') + name;
                    } catch { return '? ' + name; }
                });
                return items.length ? items.join('\n') : '(空目录)';
            }
            function doOpenfile(p, offset, limit) {
                const abs = safe(p);
                if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + p);
                if (fs.statSync(abs).isDirectory()) throw new Error(`"${p}" 是目录`);
                const text = fs.readFileSync(abs, 'utf8');
                const total = text.length;
                let start = parseInt(offset, 10);
                if (!Number.isFinite(start) || start < 0) start = 0;
                let len = parseInt(limit, 10);
                if (!Number.isFinite(len) || len <= 0) len = 8000;
                len = Math.min(len, 200000);
                if (start > 0 && start >= total && total > 0) {
                    return `文件 ${p}（共 ${total} 字符）: offset=${start} 已超出文件长度`;
                }
                const slice = text.slice(start, start + len);
                const end = start + slice.length;
                const more = end < total;
                const head = `文件 ${p}（第 ${start}-${end} 字符 / 共 ${total} 字符${more ? `，未完，可设 offset=${end} 继续读` : ''}）:`;
                return `${head}\n\`\`\`\n${slice}\n\`\`\``;
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
                                if (isBackup(name)) continue;
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
            // ===== 全文检索（内容 + 文件名）=====
            function doSearch(keyword, rootP, opts) {
                opts = opts || {};
                const kw = String(keyword == null ? '' : keyword);
                if (!kw) throw new Error('缺少 pattern（搜索关键词或正则）');
                const useRegex = !!opts.regex;
                const namePat = String(opts.name || '').trim();
                const contextN = Math.max(0, Math.min(parseInt(opts.context, 10) || 0, 5));
                const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 50, 200));
                let re;
                if (useRegex) {
                    try { re = new RegExp(kw, 'i'); } catch (e) { throw new Error('正则无效: ' + e.message); }
                } else {
                    const escKw = kw.replace(/[.*+?^$()|[\]\\{}]/g, '\\            function doStat(p) {');
                    re = new RegExp(escKw, 'i');
                }
                let nameRe = null;
                if (namePat) { try { nameRe = globToRegex(namePat); } catch (e) {} }
                const abs = safe(rootP || '.');
                if (!fs.existsSync(abs)) throw new Error('路径不存在: ' + rootP);
                const results = [];
                let totalFiles = 0, totalHits = 0;
                const matchName = (rel) => {
                    if (!nameRe) return true;
                    const base = rel.split('/').pop();
                    return nameRe.test(base) || nameRe.test(rel);
                };
                const scanFile = (full, rel) => {
                    let text;
                    try {
                        const st = fs.statSync(full);
                        if (!st.isFile() || st.size > MAX_FILE) return;
                        text = fs.readFileSync(full, 'utf8');
                    } catch (e) { return; }
                    if (isBinaryText(text)) return;
                    totalFiles++;
                    const lines = text.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (re.test(lines[i])) {
                            totalHits++;
                            if (results.length >= limit) continue;
                            const start = Math.max(0, i - contextN);
                            const end = Math.min(lines.length, i + contextN + 1);
                            const block = [];
                            for (let k = start; k < end; k++) {
                                const mark = (k === i) ? '>' : ' ';
                                block.push(mark + (k + 1) + ': ' + lines[k].trim().slice(0, 200));
                            }
                            results.push(rel + ':' + (i + 1) + ':\n' + block.join('\n'));
                        }
                    }
                };
                if (fs.statSync(abs).isFile()) {
                    const rel = relOf(abs);
                    if (matchName(rel)) scanFile(abs, rel);
                } else {
                    (function walk(dir, depth) {
                        if (depth > MAX_DEPTH) return;
                        let names; try { names = fs.readdirSync(dir); } catch (e) { return; }
                        for (const name of names) {
                            const full = path.join(dir, name);
                            let s; try { s = fs.statSync(full); } catch (e) { continue; }
                            if (s.isDirectory()) {
                                if (SKIP_DIRS.has(name.toLowerCase())) continue;
                                walk(full, depth + 1);
                            } else {
                                if (isBackup(name)) continue;
                                const ext = '.' + name.split('.').pop().toLowerCase();
                                if (SKIP_EXTS.has(ext)) continue;
                                const rel = relOf(full);
                                if (!matchName(rel)) continue;
                                scanFile(full, rel);
                            }
                        }
                    })(abs, 0);
                }
                const head = '搜索 "' + kw + '"' + (namePat ? ' [文件名过滤:' + namePat + ']' : '') + (useRegex ? ' [正则]' : '') + ' | 扫描 ' + totalFiles + ' 文件 | 命中 ' + totalHits + ' 处';
                const suffix = results.length >= limit ? '\n...(已达上限 ' + limit + '，请缩小范围或调大 limit)' : '';
                return head + '\n' + (results.length ? results.join('\n\n') + suffix : '(无匹配)');
            }

            // ===== 目录树（独立工具，可控深度/过滤）=====
            function doTree(p, opts) {
                opts = opts || {};
                const maxDepth = Math.max(1, Math.min(parseInt(opts.depth, 10) || 4, 10));
                const filter = String(opts.filter || '').trim();
                const fExts = filter ? filter.split(/[,;]/).map(x => x.trim().toLowerCase()).filter(Boolean) : null;
                const MAXN = 2000;
                const abs = safe(p || '.');
                if (!fs.existsSync(abs)) throw new Error('目录不存在: ' + (p || '.'));
                if (!fs.statSync(abs).isDirectory()) throw new Error('"' + (p || '.') + '" 是文件不是目录');
                const lines = [];
                let count = 0;
                (function walk(dir, prefix, depth) {
                    if (depth > maxDepth) return;
                    let names; try { names = fs.readdirSync(dir).sort(); } catch (e) { return; }
                    for (const name of names) {
                        if (count >= MAXN) return;
                        const full = path.join(dir, name);
                        let s; try { s = fs.statSync(full); } catch (e) { continue; }
                        if (s.isDirectory()) {
                            if (SKIP_DIRS.has(name.toLowerCase())) { lines.push(prefix + 'D ' + name + '/ (跳过)'); count++; continue; }
                            lines.push(prefix + 'D ' + name + '/');
                            count++;
                            walk(full, prefix + '  ', depth + 1);
                        } else {
                            if (fExts) {
                                const ext = '.' + name.split('.').pop().toLowerCase();
                                if (!fExts.includes(ext) && !fExts.includes(name.toLowerCase())) continue;
                            }
                            const size = s.size < 1024 ? s.size + 'B' : (s.size / 1024).toFixed(1) + 'K';
                            lines.push(prefix + 'F ' + name + '  (' + size + ')');
                            count++;
                        }
                    }
                })(abs, '', 0);
                const head = '目录树 ' + (p || '.') + ' (深度<=' + maxDepth + (filter ? ', 过滤:' + filter : '') + '):';
                return head + '\n' + (lines.length ? lines.join('\n') : '(空目录)') + (count >= MAXN ? '\n...(已达上限)' : '');
            }

            // ===== 备份管理 =====
            function doBackups(p, opts) {
                opts = opts || {};
                const root = safe(p || '.');
                const MAXN = Math.max(1, Math.min(parseInt(opts.limit, 10) || 200, 1000));
                const list = [];
                (function walk(dir, depth) {
                    if (depth > MAX_DEPTH || list.length >= MAXN) return;
                    let names; try { names = fs.readdirSync(dir); } catch (e) { return; }
                    for (const name of names) {
                        if (list.length >= MAXN) return;
                        const full = path.join(dir, name);
                        let s; try { s = fs.statSync(full); } catch (e) { continue; }
                        if (s.isDirectory()) {
                            if (SKIP_DIRS.has(name.toLowerCase())) continue;
                            walk(full, depth + 1);
                        } else if (isBackup(name)) {
                            const orig = full.slice(0, -4);
                            list.push({
                                bak: relOf(full),
                                orig: relOf(orig),
                                origExists: fs.existsSync(orig),
                                size: s.size,
                                mtime: s.mtimeMs,
                            });
                        }
                    }
                })(root, 0);
                if (!list.length) return '没有找到任何 .bak 备份文件';
                list.sort((a, b) => b.mtime - a.mtime);
                const fmt = (ms) => new Date(ms).toLocaleString();
                const lines = list.map((x, i) =>
                    (i + 1) + '. ' + x.bak + '\n   原文件: ' + x.orig + (x.origExists ? '' : ' (原文件已不存在!)') +
                    '\n   备份大小: ' + (x.size / 1024).toFixed(1) + 'KB | 备份时间: ' + fmt(x.mtime));
                const head = '共 ' + list.length + ' 个备份' + (list.length >= MAXN ? '（已达上限）' : '') + '：';
                return head + '\n\n' + lines.join('\n');
            }

            // ===== 审计日志查看 =====
            function doAudit(opts) {
                opts = opts || {};
                const logPath = path.join(WORKSPACE, '.ds_audit.log');
                if (!fs.existsSync(logPath)) return '尚无审计日志（还没有任何写操作被记录）';
                let text = fs.readFileSync(logPath, 'utf8');
                const filter = String(opts.filter || opts.pattern || '').trim();
                const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 100, 2000));
                let lines = text.split('\n').filter(Boolean);
                if (filter) {
                    let re;
                    try { re = new RegExp(filter, 'i'); } catch (e) { throw new Error('filter 正则无效: ' + e.message); }
                    lines = lines.filter(l => re.test(l));
                }
                const total = lines.length;
                lines = lines.slice(-limit);
                if (!lines.length) return '审计日志中无匹配记录' + (filter ? '（filter: ' + filter + '）' : '');
                return '审计日志（显示最后 ' + lines.length + ' 条，共匹配 ' + total + ' 条）:\n' + lines.join('\n');
            }

            // ===== 清理旧备份 =====
            function doCleanbaks(p, opts) {
                opts = opts || {};
                const keepDays = Math.max(0, parseInt(opts.keepDays, 10) || 0);
                const keepLatest = Math.max(0, parseInt(opts.keepLatest, 10) || 0);
                if (!keepDays && !keepLatest) throw new Error('需指定 keepDays（保留最近N天）或 keepLatest（每个文件保留最近N个）');
                const root = safe(p || '.');
                const baks = [];
                (function walk(dir, depth) {
                    if (depth > MAX_DEPTH) return;
                    let names; try { names = fs.readdirSync(dir); } catch (e) { return; }
                    for (const name of names) {
                        const full = path.join(dir, name);
                        let s; try { s = fs.statSync(full); } catch (e) { continue; }
                        if (s.isDirectory()) {
                            if (SKIP_DIRS.has(name.toLowerCase())) continue;
                            walk(full, depth + 1);
                        } else if (isBackup(name)) {
                            baks.push({ full, name, mtime: s.mtimeMs });
                        }
                    }
                })(root, 0);
                const toDelete = [];
                if (keepDays) {
                    const cutoff = Date.now() - keepDays * 86400000;
                    for (const b of baks) if (b.mtime < cutoff) toDelete.push(b);
                }
                if (keepLatest) {
                    const groups = {};
                    for (const b of baks) {
                        const base = b.full.slice(0, -4);
                        (groups[base] = groups[base] || []).push(b);
                    }
                    for (const k of Object.keys(groups)) {
                        const arr = groups[k].sort((a, b) => b.mtime - a.mtime);
                        for (let i = keepLatest; i < arr.length; i++) {
                            if (!toDelete.includes(arr[i])) toDelete.push(arr[i]);
                        }
                    }
                }
                let okN = 0, failN = 0;
                for (const b of toDelete) {
                    try { fs.unlinkSync(b.full); okN++; }
                    catch (e) { failN++; }
                }
                return '备份清理完成：删除 ' + okN + ' 个' + (failN ? '，失败 ' + failN + ' 个' : '') + '（扫描到 ' + baks.length + ' 个备份）';
            }

            // ===== 批量文件操作 =====
            function doBatch(actions, force) {
                if (!Array.isArray(actions) || !actions.length) throw new Error('actions 必须是非空数组');
                if (actions.length > 50) throw new Error('单次 batch 最多 50 个操作');
                const out = [];
                let okN = 0, failN = 0;
                for (let i = 0; i < actions.length; i++) {
                    const a = actions[i] || {};
                    const aop = String(a.op || '').toLowerCase();
                    const label = a.path || a.from || '';
                    try {
                        if (!aop) throw new Error('缺少 op');
                        if (!WRITE_OPS.has(aop) || aop === 'batch') throw new Error('batch 仅支持写操作: mkdir/writefile/append/del/move/copy/edit/editline/replaceall');
                        const targets = [a.path, a.from, a.to].filter(Boolean);
                        for (const tp of targets) checkDanger(safe(tp), aop, force);
                        let r;
                        switch (aop) {
                            case 'mkdir': r = doMkdir(a.path); break;
                            case 'writefile': r = doWritefile(a.path, a.content); break;
                            case 'append': r = doAppend(a.path, a.content); break;
                            case 'del': r = doDel(a.path); break;
                            case 'move': r = doMove(a.from, a.to); break;
                            case 'copy': r = doCopy(a.from, a.to); break;
                            case 'edit': r = doEdit(a.path, a.old, a.new); break;
                            case 'editline': r = doEditline(a.path, parseInt(a.line, 10), a.mode, a.content); break;
                            case 'replaceall': r = doReplaceall(a.path || '.', a.find, a.replace); break;
                            case 'restore': r = doRestore(a.path); break;
                            default: throw new Error('不支持的子操作: ' + aop);
                        }
                        auditLog('batch:' + aop, label, 'OK');
                        okN++;
                        out.push('[' + (i + 1) + '] OK  ' + aop + ' ' + label + ' -> ' + r);
                    } catch (e) {
                        failN++;
                        auditLog('batch:' + aop + ':FAIL', label, e.message);
                        out.push('[' + (i + 1) + '] FAIL ' + aop + ' ' + label + ' -> ' + e.message);
                    }
                }
                return '批量操作完成：成功 ' + okN + '，失败 ' + failN + '\n' + out.join('\n');
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
            function doRestore(p) {
                const abs = safe(p);
                const bak = abs + '.bak';
                if (!fs.existsSync(bak)) throw new Error('备份不存在: ' + p + '.bak（只有被 writefile/edit/append 等修改过的文件才有 .bak 备份）');
                if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new Error('目标是目录，无法恢复');
                fs.copyFileSync(bak, abs);
                return `已从备份恢复: ${p}（来源 ${p}.bak）`;
            }

            let result;
            const forceFlag = body.force === true || body.force === 'true';
            if (WRITE_OPS.has(op) && op !== 'batch') {
                const targets = [body.path, body.from, body.to].filter(Boolean);
                for (const tp of targets) checkDanger(safe(tp), op, forceFlag);
            }
            switch (op) {
                case 'listdir': result = doListdir(body.path || '.', body.tree); break;
                case 'openfile': result = doOpenfile(body.path, body.offset, body.limit); break;
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
                case 'restore': result = doRestore(body.path); break;
                case 'tree': result = doTree(body.path, body); break;
                case 'search': result = doSearch(body.pattern || body.keyword, body.path, body); break;
                case 'batch': result = doBatch(body.actions, forceFlag); break;
                case 'backups': result = doBackups(body.path, body); break;
                case 'audit': result = doAudit(body); break;
                case 'cleanbaks': result = doCleanbaks(body.path, body); break;
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
            if (WRITE_OPS.has(op) && op !== 'batch') {
                auditLog(op, body.path || body.from || body.to || '', forceFlag ? 'force' : '');
            }
            return sendJson(res, 200, { ok: true, result: String(result) });
        } catch (e) {
            return sendJson(res, 200, { ok: false, error: e.message });
        }
    }

    if (req.method === 'POST' && pathname === '/download') {
        // 二进制下载：绕过 JSON 的 1MB 请求体限制，供前端构造 File 拖入输入框
        try {
            const { path: p } = JSON.parse(await readBody(req) || '{}');
            if (!p) return sendJson(res, 400, { error: '缺少 path' });
            const abs = path.resolve(WORKSPACE, String(p));
            const rel = path.relative(WORKSPACE, abs);
            if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
                return sendJson(res, 403, { error: '不允许访问工作区外路径: ' + p });
            }
            if (!fs.existsSync(abs)) return sendJson(res, 404, { error: '文件不存在: ' + p });
            const st = fs.statSync(abs);
            if (!st.isFile()) return sendJson(res, 400, { error: '不是文件: ' + p });
            const MAX_DL = 200 * 1024 * 1024;
            if (st.size > MAX_DL) return sendJson(res, 413, { error: '文件过大（>' + (MAX_DL/1024/1024) + 'MB）' });
            const ext = path.extname(abs).toLowerCase();
            const mimeMap = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp','.ico':'image/x-icon','.pdf':'application/pdf','.txt':'text/plain','.md':'text/markdown','.json':'application/json','.csv':'text/csv','.zip':'application/zip','.mp4':'video/mp4','.mp3':'audio/mpeg' };
            const mime = mimeMap[ext] || 'application/octet-stream';
            const fname = encodeURIComponent(path.basename(abs));
            res.writeHead(200, {
                'Content-Type': mime,
                'Content-Length': st.size,
                'Content-Disposition': "attachment; filename*=UTF-8''" + fname,
                'Access-Control-Expose-Headers': 'Content-Disposition',
            });
            fs.createReadStream(abs).pipe(res);
        } catch (e) {
            return sendJson(res, 500, { error: e.message });
        }
        return;
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

            // 关键：把命令写入临时脚本再执行，彻底规避命令行引号/&/%/> 被转义层吞掉
            const os = require('os');
            const tmpScript = path.join(os.tmpdir(),
                'ds_exec_' + Date.now() + '_' + Math.floor(Math.random() * 1000) + (isWin ? '.bat' : '.sh'));
            try {
                const scriptBody = isWin
                    ? '@echo off\r\nchcp 65001 >nul\r\n' + command
                    : '#!/bin/sh\n' + command;
                fs.writeFileSync(tmpScript, scriptBody, 'utf8');
                if (!isWin) { try { fs.chmodSync(tmpScript, 0o755); } catch {} }
            } catch (e) {
                return sendJson(res, 500, { error: '无法创建临时执行脚本: ' + e.message });
            }

            const args = isWin ? ['/c', tmpScript] : [tmpScript];
            const child = require('child_process').spawn(shell, args, { cwd: workDir, windowsHide: true });
            // 进程退出即清理临时脚本（正常结束、超时后台结束都覆盖）
            child.on('exit', () => { try { fs.unlinkSync(tmpScript); } catch {} });
            
            let output = '';
            let outputTruncated = false;
            let detachListeners = null;
            let responded = false;
            let clientGone = false;

            const appendOutput = (d) => {
                if (outputTruncated) return;
                output += d.toString('utf8');
                // 超过上限后保留尾部（最新输出更有价值），并停止追加
                if (output.length > MAX_BUFFER) {
                    output = output.slice(-MAX_BUFFER);
                    outputTruncated = true;
                }
            };

            const sendResponse = (exitCode, msg = '', extra = {}) => {
                if (responded) return;
                responded = true;
                const payload = Object.assign({ output: output + msg, exitCode, pid: child.pid }, extra);
                if (outputTruncated) payload.truncated = true;
                sendJson(res, 200, payload);
            };

            // 前台监听：超时后解绑，防止长驻进程持续写内存
            const onStdout = d => appendOutput(d);
            const onStderr = d => appendOutput(d);
            child.stdout.on('data', onStdout);
            child.stderr.on('data', onStderr);
            detachListeners = () => {
                try { child.stdout.removeListener('data', onStdout); } catch {}
                try { child.stderr.removeListener('data', onStderr); } catch {}
            };
            
            child.on('close', code => {
                detachListeners();
                if (!responded) sendResponse(code === null ? 1 : code);
            });
            
            child.on('error', err => {
                detachListeners();
                sendResponse(1, `\n[启动失败] ${err.message}`);
            });

            // 客户端断开（页面刷新、fetch 中断）：杀掉进程，避免孤儿
            res.on('close', () => {
                if (!responded) {
                    clientGone = true;
                    detachListeners();
                    try { child.kill(); } catch {}
                }
            });

            setTimeout(() => {
                if (!responded && !clientGone) {
                    detachListeners();
                    sendResponse(0, `\n[进程运行超过 ${timeout/1000} 秒，已转入后台运行。PID: ${child.pid}。如果觉得卡死，可使用 kill_process 终止]`, { background: true });
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
            const { url, method = 'GET', content, headers = {}, saveTo } = JSON.parse(await readBody(req) || '{}');
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
                        buf: Buffer.concat(chunks),
                    }));
                    resp.on('error', reject);
                });
                r.setTimeout(FETCH_TIMEOUT, () => r.destroy(new Error(`请求超时（${FETCH_TIMEOUT/1000}s）`)));
                r.on('error', reject);
                if (bodyBuf) r.write(bodyBuf);
                r.end();
            });
            const text = result.buf.toString('utf8');
            let savedPath = null;
            if (typeof saveTo === 'string' && saveTo.trim()) {
                const abs = path.resolve(WORKSPACE, saveTo.trim());
                const rel = path.relative(WORKSPACE, abs);
                if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
                    return sendJson(res, 200, { error: '不允许写入工作区外路径: ' + saveTo, type: '越界' });
                }
                fs.mkdirSync(path.dirname(abs), { recursive: true });
                if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                    try { fs.copyFileSync(abs, abs + '.bak'); } catch {}
                }
                fs.writeFileSync(abs, result.buf);
                savedPath = rel.split(path.sep).join('/') || '.';
            }
            sendJson(res, 200, { status: result.status, statusText: result.statusText, text, bytes: result.buf.length, savedPath });
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