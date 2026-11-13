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
    description: `
在本地执行 SQLite 数据库操作（零依赖，使用 Node.js 内置 sqlite 模块）。
【参数】
- action: 'query' (执行 SELECT 并返回 JSON) 或 'exec' (执行 CREATE/INSERT/UPDATE/DELETE)
- db: 数据库文件相对路径，如 "data/test.db"。如果目录不存在会自动创建。
- sql: 要执行的 SQL 语句。
【示例】
{"op":"sqlite_tool","action":"exec","db":"test.db","sql":"CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT);"}
{"op":"sqlite_tool","action":"query","db":"test.db","sql":"SELECT * FROM users;"}
`,
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
