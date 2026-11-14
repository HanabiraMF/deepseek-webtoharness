const { resolveWsPath, getWorkspace } = require('./_workspace');
const fs = require('fs');
const path = require('path');

const V = (a, k) => {
    if (!a) return '';
    if (a[k] != null && a[k] !== '') return String(a[k]);
    const ex = a.extraArgs || {};
    if (ex[k] != null && ex[k] !== '') return String(ex[k]);
    const lower = k.toLowerCase();
    for (const key of Object.keys(ex)) { if (key.toLowerCase() === lower && ex[key] != null) return String(ex[key]); }
    return '';
};

module.exports = {
    name: 'sqlite_tool',
    description: "SQLite 数据库操作，零依赖",
    params: [
        { k: "action", cn: "操作", req: true, d: "query 查询 / exec 执行" },
        { k: "db", cn: "数据库", req: true, d: "相对路径，如 data/test.db" },
        { k: "sql", cn: "SQL 语句", req: true, d: "" }
    ],
    execute: async (args) => {
        const action = V(args, 'action');
        const dbPath = V(args, 'db') || 'test.db';
        const sql = V(args, 'sql');
        if (!action || !sql) return '错误：需要 action 和 sql 参数';
        
        const absPath = await resolveWsPath(dbPath);
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        try {
            const { DatabaseSync } = require('node:sqlite');
            const db = new DatabaseSync(absPath);
            if (action === 'query') {
                const stmt = db.prepare(sql);
                const rows = stmt.all();
                db.close();
                return JSON.stringify(rows, null, 2);
            } else {
                db.exec(sql);
                db.close();
                return '执行成功';
            }
        } catch (e) {
            return 'SQLite 错误: ' + e.message;
        }
    }
};
