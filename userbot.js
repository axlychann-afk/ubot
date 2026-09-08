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

// ---- Broadcast (terbuka, anti-limit) ----
// Daftar grup dibaca live dari dialog akun (bukan file aneh-aneh).
// Block list disimpan lokal di bcblock.txt (id per baris).
import { writeFileSync as _w, readFileSync as _r, existsSync as _e } from 'node:fs';

function blockedIds() {
  try {
    if (!_e('./bcblock.txt')) return new Set();
    return new Set(_r('./bcblock.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { return new Set(); }
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
  if (cmd === 'gclist') {
    const groups = await myGroups();
    const blocked = blockedIds();
    if (!groups.length) { await reply(msg, 'belum join grup/channel apa pun.'); return; }
    const lines = groups.map((g, i) => `${i + 1}. ${g.title}${blocked.has(g.id) ? ' [⛔blocked]' : ''}`);
    await reply(msg, `daftar grup (${groups.length}):\n${lines.join('\n')}\n\nblock: .bcblock <nomor>\nbuka: .bcunblock <nomor>`);
    return;
  }
  if (cmd === 'bcblock' || cmd === 'bcunblock') {
    const groups = await myGroups();
    const nums = arg.split(/\s+/).map(Number).filter((n) => n >= 1 && n <= groups.length);
    if (!nums.length) { await reply(msg, `pakai: .${cmd} <nomor>\nlihat nomor di .gclist`); return; }
    const blocked = blockedIds();
    for (const n of nums) {
      if (cmd === 'bcblock') blocked.add(groups[n - 1].id);
      else blocked.delete(groups[n - 1].id);
    }
    _w('./bcblock.txt', [...blocked].join('\n'));
    await reply(msg, `${cmd === 'bcblock' ? '⛔ di-block' : '✅ dibuka'}: ${nums.join(', ')}`);
    return;
  }
  // .bc <teks> — kalau sambil reply media, media ikut diteruskan + caption
  if (!arg && !msg.replyToMsgId) { await reply(msg, 'pakai: .bc <teks promosi>\natau reply foto/video lalu .bc <caption>'); return; }
  const groups = (await myGroups()).filter((g) => !blockedIds().has(g.id));
  if (!groups.length) { await reply(msg, 'tidak ada target (semua di-block / belum join grup).'); return; }
  let fwd = null;
  if (msg.replyToMsgId) {
    try { fwd = await msg.getReplyMessage(); } catch {}
  }
  let ok = 0, fail = 0;
  const status = await client.sendMessage(msg.chatId, { message: `siaran ke ${groups.length} grup...` });
  for (const g of groups) {
    try {
      if (fwd && fwd.media) await client.sendFile(g.id, { file: fwd.media, caption: arg || fwd.text || '' });
      else await client.sendMessage(g.id, { message: arg });
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
  if (!text.startsWith(PREFIX)) return;
  const [cmd, ...rest] = text.slice(PREFIX.length).split(/\s+/);
  const arg = rest.join(' ');

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
      '.gclist — daftar grup + nomor\n' +
      '.bc <teks> — broadcast ke semua grup (ada jeda anti-limit)\n' +
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
  } else if (cmd === 'gclist' || cmd === 'bcblock' || cmd === 'bcunblock' || cmd === 'bc') {
    await handleBroadcast(cmd, arg, msg);
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

console.log('ubot-bersih jalan. Ketik .help di Saved Messages.');
await new Promise(() => {}); // tahan proses tetap hidup (GramJS tidak punya runUntilDisconnected)
