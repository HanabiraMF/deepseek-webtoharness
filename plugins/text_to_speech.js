const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
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
    name: 'text_to_speech',
    description: "文字转语音朗读，使用 Windows 内置 TTS",
    params: [
        { k: "text", cn: "文字", req: true, d: "支持中文" },
        { k: "rate", cn: "语速", req: false, d: "-10 到 10，默认 0" },
        { k: "volume", cn: "音量", req: false, d: "0 到 100，默认 100" }
    ],
    execute: async (args) => {
        const text = V(args, 'text').replace(/["'`]/g, ' ');
        if (!text) return '错误：缺少要朗读的 text 参数';
        const rate = parseInt(V(args, 'rate') || '0', 10);
        const volume = parseInt(V(args, 'volume') || '100', 10);

        const ps = `
            Add-Type -AssemblyName System.Speech
            $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
            $synth.Rate = ${rate}
            $synth.Volume = ${volume}
            $synth.Speak('${text}')
        `;
        const tmpFile = path.join(os.tmpdir(), 'ds_tts_' + Date.now() + '.ps1');
        fs.writeFileSync(tmpFile, '\uFEFF' + ps, 'utf8');

        return new Promise((resolve) => {
            // 注意：speak 是阻塞的，直到念完才会返回
            exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
                try { fs.unlinkSync(tmpFile); } catch (e) {}
                if (err) return resolve('语音播报失败: ' + (stderr || err.message));
                resolve('语音播报完成');
            });
        });
    }
};
