const { resolveWsPath, getWorkspace } = require('./_workspace');
const crypto = require('crypto');
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
    name: 'crypto_tool',
    description: "加密与编码：哈希、AES 加解密、随机密码",
    params: [
        { k: "action", cn: "操作", req: true, d: "hash / aes_encrypt / aes_decrypt / random" },
        { k: "text", cn: "文本", req: false, d: "明文或密文" },
        { k: "source", cn: "源文件", req: false, d: "读取文件内容作为 text" },
        { k: "algorithm", cn: "哈希算法", req: false, d: "md5 / sha1 / sha256 / sha512，默认 sha256" },
        { k: "key", cn: "密钥", req: false, d: "AES 需 16/24/32 字节" },
        { k: "length", cn: "密码长度", req: false, d: "random 时使用，默认 16" }
    ],
    execute: async (args) => {
        const action = V(args, 'action');
        let text = V(args, 'text');
        const source = V(args, 'source');
        if (!action) return '错误：缺少 action';
        if (!text && source) {
            const abs = await resolveWsPath(source);
            if (!fs.existsSync(abs)) return '错误：文件不存在 ' + source;
            text = fs.readFileSync(abs);
        }
        if (action === 'hash') {
            if (!text) return '错误：缺少 text 或 source';
            const algo = (V(args, 'algorithm') || 'sha256').toLowerCase();
            if (!['md5', 'sha1', 'sha256', 'sha512'].includes(algo)) return '错误：不支持的算法，可选 md5/sha1/sha256/sha512';
            const h = crypto.createHash(algo).update(text).digest('hex');
            return `${algo.toUpperCase()}: ${h}`;
        }
        if (action === 'aes_encrypt') {
            if (!text) return '错误：缺少 text';
            const keyStr = V(args, 'key') || 'ds_agent_default_key_0123456789';
            const key = crypto.createHash('sha256').update(keyStr).digest();
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
            const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
            return iv.toString('hex') + ':' + enc.toString('hex');
        }
        if (action === 'aes_decrypt') {
            if (!text) return '错误：缺少 text';
            const parts = String(text).split(':');
            if (parts.length !== 2) return '错误：密文格式不对，应为 ivHex:cipherHex';
            const keyStr = V(args, 'key') || 'ds_agent_default_key_0123456789';
            const key = crypto.createHash('sha256').update(keyStr).digest();
            const iv = Buffer.from(parts[0], 'hex');
            const enc = Buffer.from(parts[1], 'hex');
            try {
                const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
                const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
                return dec.toString('utf8');
            } catch (e) {
                return '解密失败: ' + e.message;
            }
        }
        if (action === 'random') {
            const len = parseInt(V(args, 'length') || '16', 10);
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
            let pwd = '';
            const bytes = crypto.randomBytes(len);
            for (let i = 0; i < len; i++) pwd += chars[bytes[i] % chars.length];
            return `随机密码 (${len} 位): ${pwd}`;
        }
        return '错误：action 必须是 hash / aes_encrypt / aes_decrypt / random';
    }
};
