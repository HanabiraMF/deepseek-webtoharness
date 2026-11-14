const { resolveWsPath } = require('./_workspace');
const fs = require('fs');
const path = require('path');

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

function rnd(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[rnd(arr.length)]; }

const FIRST = ['张', '李', '王', '刘', '陈', '杨', '赵', '黄', '周', '吴'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '强', '洋', '艳', '杰'];
const CITY = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安', '南京', '重庆'];
const DOMAIN = ['example.com', 'test.local', 'mail.net', 'demo.org'];
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'sigma', 'omega', 'test', 'demo', 'hello', 'world', 'data', 'user', 'item', 'order'];

function schemaField(f, rowIdx) {
    const type = String(f.type || 'string').toLowerCase();
    if (type === 'increment' || type === 'id') return rowIdx + 1;
    if (type === 'int' || type === 'integer' || type === 'number') {
        const min = f.min == null ? 0 : Number(f.min);
        const max = f.max == null ? 1000 : Number(f.max);
        if (type === 'number' && f.decimals != null) return Number((min + Math.random() * (max - min)).toFixed(Number(f.decimals)));
        return Math.floor(min + Math.random() * (max - min + 1));
    }
    if (type === 'float' || type === 'double') {
        const min = f.min == null ? 0 : Number(f.min);
        const max = f.max == null ? 1 : Number(f.max);
        return Number((min + Math.random() * (max - min)).toFixed(Number(f.decimals == null ? 2 : f.decimals)));
    }
    if (type === 'bool' || type === 'boolean') return Math.random() > 0.5;
    if (type === 'date') return new Date(Date.now() - rnd(365 * 86400 * 1000)).toISOString();
    if (type === 'email') return pick(WORDS) + rowIdx + '@' + pick(DOMAIN);
    if (type === 'name') return pick(FIRST) + pick(GIVEN);
    if (type === 'city') return pick(CITY);
    if (type === 'phone') return '1' + pick(['3', '5', '7', '8', '9']) + String(1000000000 + rnd(899999999)).slice(0, 9);
    if (type === 'uuid') {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }
    if (type === 'enum') {
        const opts = Array.isArray(f.values) ? f.values : ['A', 'B', 'C'];
        return pick(opts);
    }
    if (type === 'seq') return (f.prefix || '') + (rowIdx + 1);
    return pick(WORDS) + '_' + rowIdx;
}

function toCsv(rows, headers) {
    const esc = (v) => {
        if (v == null) return '';
        const s = String(v).replace(/"/g, '""');
        return s.includes(',') || s.includes('\n') || s.includes('"') ? '"' + s + '"' : s;
    };
    const out = [headers.map(esc).join(',')];
    for (const r of rows) out.push(headers.map(h => esc(r[h])).join(','));
    return out.join('\n');
}

module.exports = {
    name: 'fixture_gen',
    description: "生成随机测试数据，输出 JSON / CSV / SQL",
    params: [
        { k: "schema", cn: "字段定义", req: true, d: "JSON 数组，每项 {name,type,...}；type 支持 id/increment/int/number/float/bool/date/email/name/city/phone/uuid/enum/seq/string" },
        { k: "rows", cn: "行数", req: false, d: "默认 10，上限 10000" },
        { k: "format", cn: "输出格式", req: false, d: "json / csv / sql，默认 json" },
        { k: "dest", cn: "输出文件", req: false, d: "不填直接返回" },
        { k: "table", cn: "表名", req: false, d: "sql 格式用，默认 data" },
        { k: "pretty", cn: "美化输出", req: false, d: "json 是否美化，默认 true" }
    ],
    execute: async (args) => {
        const schemaRaw = V(args, 'schema');
        if (!schemaRaw) return '错误：缺少 schema';
        let schema;
        try { schema = JSON.parse(schemaRaw); } catch (e) { return '错误：schema 不是合法 JSON - ' + e.message; }
        if (!Array.isArray(schema) || !schema.length) return '错误：schema 必须是数组且非空';
        for (const f of schema) {
            if (!f || !f.name) return '错误：schema 每项必须有 name';
        }

        const rows = Math.min(Math.max(parseInt(V(args, 'rows') || '10', 10) || 10, 1), 10000);
        const format = (V(args, 'format') || 'json').toLowerCase();
        const dest = V(args, 'dest');
        const table = V(args, 'table') || 'data';
        const pretty = V(args, 'pretty') === '' ? true : /^(true|1|yes)$/i.test(V(args, 'pretty'));

        const data = [];
        for (let i = 0; i < rows; i++) {
            const obj = {};
            for (const f of schema) obj[f.name] = schemaField(f, i);
            data.push(obj);
        }

        let out;
        const headers = schema.map(f => f.name);
        if (format === 'json') {
            out = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
        } else if (format === 'csv') {
            out = toCsv(data, headers);
        } else if (format === 'sql') {
            const sqlEscape = (v) => {
                if (v == null) return 'NULL';
                if (typeof v === 'number') return String(v);
                if (typeof v === 'boolean') return v ? '1' : '0';
                return "'" + String(v).replace(/'/g, "''") + "'";
            };
            const lines = [];
            lines.push('-- fixture_gen 生成 ' + rows + ' 行，表 ' + table);
            for (const r of data) {
                lines.push('INSERT INTO ' + table + ' (' + headers.join(', ') + ') VALUES (' + headers.map(h => sqlEscape(r[h])).join(', ') + ');');
            }
            out = lines.join('\n');
        } else {
            return '错误：format 必须是 json / csv / sql';
        }

        if (dest) {
            const abs = await resolveWsPath(dest);
            const dir = path.dirname(abs);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(abs, out, 'utf8');
            return '已生成测试数据: ' + dest + '\n格式: ' + format + '  行数: ' + rows + '  大小: ' + Buffer.byteLength(out) + ' 字节';
        }

        if (out.length > 6000) {
            return out.slice(0, 6000) + '\n...(输出过长已截断，共 ' + out.length + ' 字符；建议指定 dest 保存)';
        }
        return out;
    }
};
