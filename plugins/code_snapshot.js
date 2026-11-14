const { resolveWsPath } = require('./_workspace');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const SNAP_DIR = '.ds_snapshots';
const SKIP_DIRS = new Set(['node_modules', '.git', '.ds_snapshots', '__pycache__', '.venv', 'venv', 'dist', 'build']);
const MAX_FILES = 5000;

function scan(root) {
    const map = {};
    let count = 0;
    const walk = (dir) => {
        if (count >= MAX_FILES) return;
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
            if (count >= MAX_FILES) return;
            const full = path.join(dir, e.name);
            const rel = path.relative(root, full).replace(/\\/g, '/');
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                walk(full);
            } else if (e.isFile()) {
                try {
                    const st = fs.statSync(full);
                    if (st.size > 5 * 1024 * 1024) { // 大文件只记 size，不 hash 内容
                        map[rel] = { size: st.size, mtime: st.mtimeMs, hash: 'big:' + st.size };
                    } else {
                        const h = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
                        map[rel] = { size: st.size, mtime: st.mtimeMs, hash: h };
                    }
                    count++;
                } catch (e) { /* ignore */ }
            }
        }
    };
    walk(root);
    return map;
}

function loadSnap(name) {
    const abs = path.join(SNAP_DIR, name + '.json');
    if (!fs.existsSync(abs)) return null;
    try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { return null; }
}

function saveSnap(name, map) {
    if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
    const abs = path.join(SNAP_DIR, name + '.json');
    fs.writeFileSync(abs, JSON.stringify(map, null, 2), 'utf8');
    return abs;
}

function diffMaps(oldMap, newMap) {
    const added = [], removed = [], modified = [];
    for (const k of Object.keys(newMap)) {
        if (!(k in oldMap)) added.push(k);
        else if (oldMap[k].hash !== newMap[k].hash || oldMap[k].size !== newMap[k].size) modified.push(k);
    }
    for (const k of Object.keys(oldMap)) {
        if (!(k in newMap)) removed.push(k);
    }
    return { added, removed, modified };
}

module.exports = {
    name: 'code_snapshot',
    description: "目录文件哈希快照与对比，找出新增/删除/修改的文件",
    params: [
        { k: "action", cn: "操作", req: true, d: "save 保存 / diff 对比 / list 列出 / remove 删除" },
        { k: "name", cn: "快照名", req: false, d: "默认 default" },
        { k: "path", cn: "子目录", req: false, d: "默认工作区根" }
    ],
    execute: async (args) => {
        const action = (V(args, 'action') || 'diff').toLowerCase();
        const name = (V(args, 'name') || 'default').replace(/[^\w\-\.]/g, '_');
        const sub = V(args, 'path');
        const ws = await resolveWsPath('');
        const root = sub ? await resolveWsPath(sub) : ws;
        if (!fs.existsSync(root)) return '错误：目录不存在 ' + sub;

        if (action === 'list') {
            if (!fs.existsSync(SNAP_DIR)) return '暂无快照';
            const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json'));
            if (!files.length) return '暂无快照';
            const lines = files.map(f => {
                const st = fs.statSync(path.join(SNAP_DIR, f));
                let cnt = 0;
                try { cnt = Object.keys(JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8'))).length; } catch (e) {}
                return '- ' + f.replace(/\.json$/, '') + '  (' + cnt + ' 文件, ' + new Date(st.mtimeMs).toLocaleString() + ')';
            });
            return '快照列表:\n' + lines.join('\n');
        }

        if (action === 'remove') {
            const abs = path.join(SNAP_DIR, name + '.json');
            if (!fs.existsSync(abs)) return '快照不存在: ' + name;
            fs.unlinkSync(abs);
            return '已删除快照: ' + name;
        }

        if (action === 'save') {
            const map = scan(root);
            const abs = saveSnap(name, map);
            return '快照已保存: ' + name + '\n文件数: ' + Object.keys(map).length + '\n路径: ' + path.relative(ws, abs).replace(/\\/g, '/');
        }

        if (action === 'diff') {
            const oldMap = loadSnap(name);
            if (!oldMap) return '快照不存在: ' + name + '（请先 action=save）';
            const newMap = scan(root);
            const d = diffMaps(oldMap, newMap);
            const total = d.added.length + d.removed.length + d.modified.length;
            if (!total) return '无变化 ✅（对比快照 ' + name + '，共 ' + Object.keys(newMap).length + ' 文件）';
            const lines = [];
            lines.push('对比快照 ' + name + '：新增 ' + d.added.length + ' / 删除 ' + d.removed.length + ' / 修改 ' + d.modified.length);
            const fmt = (arr, prefix) => arr.slice(0, 100).map(f => '  ' + prefix + ' ' + f + (arr.length > 100 ? '（等 ' + arr.length + ' 项）' : '')).join('\n');
            if (d.added.length) lines.push('新增:\n' + fmt(d.added, '+'));
            if (d.removed.length) lines.push('删除:\n' + fmt(d.removed, '-'));
            if (d.modified.length) lines.push('修改:\n' + fmt(d.modified, 'M'));
            return lines.join('\n');
        }

        return '错误：action 必须是 save / diff / list / remove';
    }
};
