// ubot-bersih — GramJS userbot, source terbuka.
// AUDIT CEPAT (baca sebelum jalan):
//  - SATU-SATUNYA koneksi keluar: ke server resmi Telegram (GramJS).
//  - TIDAK ADA axios/fetch ke server lain, TIDAK ADA kirim session ke mana pun.
//  - Session cuma disimpan di file lokal "session.txt" (jangan disebar).
//  - Tidak ada eval, tidak ada child_process, tidak ada kode acak.

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import input from 'input';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API_ID = Number(process.env.API_ID || 33368086);
const API_HASH = process.env.API_HASH || 'b59f9ae7c4927b23cf4d70f524870903';
if (!API_ID || !API_HASH) {
  console.log('Isi dulu: API_ID + API_HASH dari https://my.telegram.org');
  console.log('PowerShell: $env:API_ID="12345"; $env:API_HASH="abcdef"; npm start');
  process.exit(1);
}

let saved = '';
try {
  if (existsSync('./session.txt')) saved = readFileSync('./session.txt', 'utf8').trim();
} catch {}
const session = new StringSession(saved);
const client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 5 });

await client.start({
  phoneNumber: async () => await input.text('Nomor (+62xxx): '),
  password: async () => await input.text('Password 2FA (kosongkan bila tidak ada): '),
  phoneCode: async () => await input.text('Kode OTP: '),
  onError: (e) => console.log('Login:', e.message),
});
writeFileSync('./session.txt', client.session.save());
console.log('Login OK. Session tersimpan LOKAL di session.txt. Jangan disebar ke siapa pun.');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREFIX = '.';

async function reply(msg, text) {
  await client.sendMessage(msg.chatId, { message: text, replyTo: msg.id });
}

// ---- Broadcast ALLOWLIST (sunyi, anti-limit) ----
// Default: TIDAK ADA grup yang kena siaran. Allow dulu baru kena.
// - Di grup: ketik /start atau .allow (dari akun sendiri) -> grup masuk allowlist,
//   pesan perintahnya DIHAPUS biar tidak ketahuan ubot. Tanpa teks balasan di grup.
// - .gclist (di Saved Messages) -> daftar + nomor, dipecah per 10 biar tidak MESSAGE_TOO_LONG.
// - .bc -> cuma kirim ke yang di-allow. .deny <nomor> buat cabut.
// Allow list disimpan lokal di allow.txt (id per baris).
import { writeFileSync as _w, readFileSync as _r, existsSync as _e } from 'node:fs';

function allowIds() {
  try {
    if (!_e('./allow.txt')) return new Set();
    return new Set(_r('./allow.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { return new Set(); }
}
function saveAllow(set) {
  _w('./allow.txt', [...set].join('\n'));
}

// ---- AUTOBC (siaran otomatis tiap N chat masuk di grup allow) ----
// - .setpromo <teks> (atau reply pesan/media + .setpromo <caption>) = simpan promo.
// - .autobc on / off = nyala/mati. .setlimit <angka> = ganti batas (default 100).
// - .autostat = lihat status + counter per grup.
// - Tiap chat MASUK (bukan dari akun sendiri) di grup allow dihitung.
//   Begitu SATU grup nyentuh limit -> promo disebar ke SEMUA grup allow,
//   counter grup pemicu direset 0. Ada cooldown 5 menit anti-spam.
function autobcCfg() {
  try {
    if (!_e('./autobc.json')) return { on: false, limit: 100, lastBc: 0 };
    const c = JSON.parse(_r('./autobc.json', 'utf8'));
    return { on: !!c.on, limit: Number(c.limit) >= 10 ? Number(c.limit) : 100, lastBc: Number(c.lastBc) || 0 };
  } catch { return { on: false, limit: 100, lastBc: 0 }; }
}
function saveAutobcCfg(c) {
  _w('./autobc.json', JSON.stringify(c));
}
function autobcCounts() {
  try {
    if (!_e('./autobc_count.json')) return {};
    return JSON.parse(_r('./autobc_count.json', 'utf8'));
  } catch { return {}; }
}
function saveAutobcCounts(o) {
  _w('./autobc_count.json', JSON.stringify(o));
}
function getPromo() {
  try {
    if (!_e('./promo.txt')) return '';
    return _r('./promo.txt', 'utf8');
  } catch { return ''; }
}

const AUTOBC_COOLDOWN = 5 * 60 * 1000; // 5 menit antar siaran otomatis

async function firePromo(groups, promoText) {
  let ok = 0, fail = 0;
  const hasMedia = _e('./promo_media');
  for (const g of groups) {
    try {
      if (hasMedia) await client.sendFile(g.id, { file: './promo_media', caption: promoText });
      else await sendLong(g.id, promoText);
      ok++;
    } catch (e) {
      fail++;
      if (/FLOOD|WAIT/i.test(e.message || '')) {
        const s = Number((e.message.match(/(\d+)/) || [])[1]) || 30;
        await sleep(Math.min(s, 60) * 1000);
      }
    }
    await sleep(3000); // jeda anti-limit, jangan dikecilin
  }
  return { ok, fail };
}

// Kirim teks panjang dengan cara dipecah per 3500 karakter (batas aman Telegram).
async function sendLong(chatId, text, replyTo) {
  const chunks = text.match(/[\s\S]{1,3500}/g) || [text];
  let first = null;
  for (const c of chunks) {
    first = await client.sendMessage(chatId, { message: c, replyTo: replyTo && !first ? replyTo : undefined });
    if (chunks.length > 1) await sleep(800);
  }
  return first;
}

async function myGroups() {
  const out = [];
  for await (const d of client.iterDialogs({})) {
    if (!d.isGroup && !d.isChannel) continue;
    out.push({ id: String(d.id), title: d.title || String(d.id) });
  }
  return out;
}

async function handleBroadcast(cmd, arg, msg) {
  if (cmd === 'denyall' || cmd === 'blockall') {
    saveAllow(new Set());
    await reply(msg, '⛔ allowlist dikosongkan. Target bc = 0 grup.');
    return;
  }
  if (cmd === 'gclist') {
    const groups = await myGroups();
    const allowed = allowIds();
    if (!groups.length) { await reply(msg, 'belum join grup/channel apa pun.'); return; }
    const head = `daftar grup (${groups.length}, di-allow ${groups.filter((g) => allowed.has(g.id)).length}):\n`;
    const lines = groups.map((g, i) => `${i + 1}. ${g.title}${allowed.has(g.id) ? ' [✅allow]' : ''}`);
    // pecah per 10 baris biar tidak MESSAGE_TOO_LONG
    await sendLong(msg.chatId, `${head}\nallow: .allow <nomor> / ketik /start di grup\ncabut: .deny <nomor>`);
    for (let i = 0; i < lines.length; i += 10) {
      await sendLong(msg.chatId, lines.slice(i, i + 10).join('\n'));
      await sleep(800);
    }
    return;
  }
  if (cmd === 'allow' || cmd === 'bcblock' || cmd === 'bcunblock' || cmd === 'deny') {
    const groups = await myGroups();
    // .allow tanpa nomor DI DALAM grup = allow grup ini
    if ((cmd === 'allow') && !arg && msg.chatId) {
      const allowed = allowIds();
      allowed.add(String(msg.chatId));
      saveAllow(allowed);
      try { await msg.delete(); } catch {}
      return;
    }
    const nums = arg.split(/\s+/).map(Number).filter((n) => n >= 1 && n <= groups.length);
    if (!nums.length) { await reply(msg, `pakai: .allow <nomor> / .deny <nomor>\nlihat nomor di .gclist`); return; }
    const allowed = allowIds();
    for (const n of nums) {
      if (cmd === 'allow' || cmd === 'bcblock') allowed.add(groups[n - 1].id);
      else allowed.delete(groups[n - 1].id);
    }
    saveAllow(allowed);
    await reply(msg, `${(cmd === 'allow' || cmd === 'bcblock') ? '✅ di-allow' : '⛔ dicabut'}: ${nums.join(', ')}`);
    return;
  }
  // .bc <teks> — HANYA ke grup yang di-allow. Kalau reply media, media ikut + caption.
  // Kalau reply pesan TEKS (tanpa media) dan tanpa arg, pakai teks reply-nya.
  let fwd = null;
  if (msg.replyToMsgId) {
    try { fwd = await msg.getReplyMessage(); } catch {}
  }
  const promoText = arg || (fwd && !fwd.media ? (fwd.text || '') : '');
  if (!promoText && !(fwd && fwd.media)) { await reply(msg, 'pakai: .bc <teks promosi>\natau reply foto/video lalu .bc <caption>'); return; }
  const groups = (await myGroups()).filter((g) => allowIds().has(g.id));
  if (!groups.length) { await reply(msg, 'belum ada grup di-allow.\nKetik /start di grup target (sunyi, otomatis masuk list), atau .allow <nomor>.'); return; }
  let ok = 0, fail = 0;
  const status = await client.sendMessage(msg.chatId, { message: `siaran ke ${groups.length} grup...` });
  for (const g of groups) {
    try {
      // arg/promoText dikirim MENTAH — spasi & baris baru utuh, dipecah via sendLong biar aman.
      if (fwd && fwd.media) await client.sendFile(g.id, { file: fwd.media, caption: promoText || fwd.text || '' });
      else await sendLong(g.id, promoText);
      ok++;
    } catch (e) {
      fail++;
      if (/FLOOD|WAIT/i.test(e.message || '')) {
        const s = Number((e.message.match(/(\d+)/) || [])[1]) || 30;
        await reply(msg, `kena limit Telegram, jeda ${s} detik...`);
        await sleep(Math.min(s, 60) * 1000);
      }
    }
    await sleep(3000); // jeda anti-limit, jangan dikecilin
  }
  await client.editMessage(msg.chatId, { message: status.id, text: `siaran selesai: ✅ ${ok} | ❌ ${fail}` });
}

client.addEventHandler(async (event) => {
  const msg = event.message;
  if (!msg || msg.out !== true) return; // cuma respon perintah dari akun sendiri
  const text = (msg.text || '').trim();
  // /start dari akun sendiri DI DALAM grup = allow sunyi (pesan dihapus, tanpa balasan)
  if (text === '/start' && msg.chatId) {
    try {
      const allowed = allowIds();
      allowed.add(String(msg.chatId));
      saveAllow(allowed);
    } catch {}
    try { await msg.delete(); } catch {}
    return;
  }
  if (!text.startsWith(PREFIX)) return;
  // JANGAN pakai split(/\s+/)+join(' ') buat arg — itu yang bikin
  // spasi ganda & baris baru (enter) ancur/gabung. Ambil mentah.
  const withoutPrefix = text.slice(PREFIX.length);
  const sp = withoutPrefix.search(/\s/);
  const cmd = sp === -1 ? withoutPrefix : withoutPrefix.slice(0, sp);
  const arg = sp === -1 ? '' : withoutPrefix.slice(sp + 1).replace(/^\s+/, '');

  if (cmd === 'ping') {
    const t0 = Date.now();
    const m = await client.sendMessage(msg.chatId, { message: 'pong...' });
    await client.editMessage(msg.chatId, { message: m.id, text: `pong! ${Date.now() - t0} ms` });
  } else if (cmd === 'help') {
    await reply(msg,
      'ubot-bersih commands:\n' +
      '.ping — cek hidup\n' +
      '.id — id chat + id sendiri\n' +
      '.info — info akun\n' +
      '.join <link/@grup> — masuk grup\n' +
      '.leave — keluar dari grup ini\n' +
      '.gclist — daftar grup + nomor (dipecah, anti MESSAGE_TOO_LONG)\n' +
      '.allow <nomor> / .deny <nomor> — atur target (atau /start di grup, sunyi)\n' +
      '.denyall — kosongkan allowlist (target = 0)\n' +
       '.bc <teks> — broadcast HANYA ke yang di-allow\n' +
       '.setpromo <teks> — simpan teks autobc (atau reply media)\n' +
       '.autobc on/off — nyala/mati siaran otomatis\n' +
       '.setlimit <n> — batas chat pemicu (default 100)\n' +
       '.autostat — status autobc + counter\n' +
      '.tagall [teks] — tag semua member (grup kecil, ada jeda)');
  } else if (cmd === 'id') {
    const me = await client.getMe();
    await reply(msg, `chat: ${msg.chatId}\nku: ${me.id} (@${me.username || '-'})`);
  } else if (cmd === 'info') {
    const me = await client.getMe();
    await reply(msg, `login sebagai ${me.firstName || ''} (@${me.username || '-'}, ${me.id})`);
  } else if (cmd === 'join') {
    if (!arg) { await reply(msg, 'pakai: .join <link/@grup>'); return; }
    try {
      await client.invoke(new (await import('telegram/tl/index.js')).Api.channels.JoinChannel({ channel: arg }));
      await reply(msg, `masuk: ${arg}`);
    } catch (e) { await reply(msg, `gagal join: ${e.message}`); }
  } else if (cmd === 'leave') {
    try {
      await client.invoke(new (await import('telegram/tl/index.js')).Api.channels.LeaveChannel({ channel: msg.chatId }));
    } catch (e) { await reply(msg, `gagal leave: ${e.message}`); }
  } else if (cmd === 'gclist' || cmd === 'allow' || cmd === 'deny' || cmd === 'denyall' || cmd === 'blockall' || cmd === 'bcblock' || cmd === 'bcunblock' || cmd === 'bc') {
    await handleBroadcast(cmd, arg, msg);
  } else if (cmd === 'setpromo') {
    // .setpromo <teks> — simpan; kalau reply media, medianya ikut disimpan.
    let fwd = null;
    if (msg.replyToMsgId) {
      try { fwd = await msg.getReplyMessage(); } catch {}
    }
    const promoText = arg || (fwd && !fwd.media ? (fwd.text || '') : (fwd && fwd.media ? (fwd.text || '') : ''));
    if (fwd && fwd.media) {
      try {
        const buf = await client.downloadMedia(fwd.media);
        _w('./promo_media', Buffer.from(buf));
      } catch (e) { await reply(msg, `gagal simpan media: ${e.message}`); return; }
    }
    if (!promoText && !(fwd && fwd.media)) { await reply(msg, 'pakai: .setpromo <teks promosi>\natau reply foto/video lalu .setpromo <caption>'); return; }
    _w('./promo.txt', promoText);
    await reply(msg, `promo tersimpan (${promoText.length} char${(fwd && fwd.media) ? ' + media' : ''}).\nNyalakan: .autobc on`);
  } else if (cmd === 'autobc') {
    const c = autobcCfg();
    const v = (arg || '').toLowerCase();
    if (v === 'on') {
      const promo = getPromo();
      if (!promo && !_e('./promo_media')) { await reply(msg, 'set promo dulu: .setpromo <teks>'); return; }
      c.on = true; saveAutobcCfg(c);
      await reply(msg, `autobc NYALA. Pemicu: ${c.limit} chat/grup allow.`);
    } else if (v === 'off') {
      c.on = false; saveAutobcCfg(c);
      await reply(msg, 'autobc MATI.');
    } else {
      await reply(msg, `pakai: .autobc on / .autobc off\nstatus sekarang: ${c.on ? 'NYALA' : 'MATI'} (limit ${c.limit})`);
    }
  } else if (cmd === 'setlimit') {
    const n = Number(arg);
    if (!n || n < 10) { await reply(msg, 'pakai: .setlimit <angka, min 10>\ncontoh: .setlimit 100'); return; }
    const c = autobcCfg();
    c.limit = Math.floor(n); saveAutobcCfg(c);
    await reply(msg, `limit autobc = ${c.limit} chat/grup.`);
  } else if (cmd === 'autostat') {
    const c = autobcCfg();
    const counts = autobcCounts();
    const groups = (await myGroups()).filter((g) => allowIds().has(g.id));
    const lines = groups.map((g) => `${g.title}: ${counts[g.id] || 0}/${c.limit}`);
    await reply(msg,
      `autobc: ${c.on ? 'NYALA ✅' : 'MATI ⛔'}\n` +
      `limit: ${c.limit} chat/grup\n` +
      `promo: ${getPromo() ? getPromo().length + ' char' : '-'}${_e('./promo_media') ? ' + media' : ''}\n` +
      (lines.length ? '\n' + lines.join('\n') : '\ntarget: 0 grup di-allow'));
  } else if (cmd === 'tagall') {
    if (!msg.chatId) { await reply(msg, 'cuma bisa di grup.'); return; }
    try {
      const parts = [];
      for await (const u of client.iterParticipants(msg.chatId, { limit: 60 })) {
        if (u.bot || !u.username) continue;
        parts.push(`@${u.username}`);
        if (parts.length % 5 === 0) {
          await client.sendMessage(msg.chatId, { message: `${arg}\n${parts.splice(0).join(' ')}` });
          await sleep(2500);
        }
      }
      if (parts.length) await client.sendMessage(msg.chatId, { message: `${arg}\n${parts.join(' ')}` });
    } catch (e) { await reply(msg, `gagal tagall: ${e.message}`); }
  }
}, new NewMessage({}));

// ---- Penghitung chat masuk buat AUTOBC (handler terpisah, cuma yang masuk) ----
client.addEventHandler(async (event) => {
  const msg = event.message;
  if (!msg || msg.out) return; // skip pesan sendiri (termasuk hasil bc)
  const gid = String(msg.chatId || '');
  if (!gid || !allowIds().has(gid)) return; // cuma grup allow
  const cfg = autobcCfg();
  if (!cfg.on) return;
  const counts = autobcCounts();
  counts[gid] = (Number(counts[gid]) || 0) + 1;
  saveAutobcCounts(counts);
  if (counts[gid] < cfg.limit) return;
  // nyentuh limit — cek promo + cooldown
  const promo = getPromo();
  if (!promo && !_e('./promo_media')) return;
  if (Date.now() - cfg.lastBc < AUTOBC_COOLDOWN) return;
  counts[gid] = 0; saveAutobcCounts(counts); // reset pemicu biar ngitung ulang
  cfg.lastBc = Date.now(); saveAutobcCfg(cfg);
  // CUMA grup pemicu yang dikirimi — grup lain gak diganggu.
  await firePromo([{ id: gid }], promo);
}, new NewMessage({ incoming: true }));

console.log('ubot-bersih jalan. Ketik .help di Saved Messages.');
await new Promise(() => {}); // tahan proses tetap hidup (GramJS tidak punya runUntilDisconnected)
