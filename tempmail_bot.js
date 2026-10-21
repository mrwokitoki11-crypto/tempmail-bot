process.env.NTBA_FIX_319 = 1;
process.env.NTBA_FIX_350 = 1;
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Kono error e bot jate crash na kore
process.on('unhandledRejection', (e) => console.error('Unhandled:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('Uncaught:', e && e.message ? e.message : e));

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_ID);

if (!BOT_TOKEN || !OWNER_ID) {
  console.error('BOT_TOKEN ba OWNER_ID .env file e nai!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
let BOT_ID = null;

const EN_BASE = 'https://www.emailnator.com';
const EN_TYPE_ID = 3; // EMAIL_TYPES: domain 1, plusGmail 2, dotGmail 3, googleMail 8
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const POLL_INTERVAL_MS = 8000;
const POLL_DURATION_MS = 30 * 60 * 1000; // 30 minute porjonto auto check
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= DATABASE (data.json) =================
const DB_FILE = path.join(__dirname, 'data.json');
let db = { users: {}, admins: [], channels: [], stats: { emails: 0, mails: 0 } };

try {
  if (fs.existsSync(DB_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db = {
      users: loaded.users || {},
      admins: loaded.admins || [],
      channels: loaded.channels || [],
      stats: Object.assign({ emails: 0, mails: 0 }, loaded.stats || {}),
    };
  }
} catch (e) {
  console.error('DB load error:', e.message);
}

let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('DB save error:', e.message);
    }
  }, 1000);
}

function trackUser(from) {
  const id = String(from.id);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'User';
  const now = Date.now();
  if (!db.users[id]) {
    db.users[id] = { name, username: from.username || '', joined: now, last: now, emails: 0, blocked: false };
  } else {
    const u = db.users[id];
    u.name = name;
    u.username = from.username || '';
    u.last = now;
    u.blocked = false;
  }
  saveDb();
}

function isOwner(id) {
  return Number(id) === OWNER_ID;
}
function isAdmin(id) {
  id = Number(id);
  return id === OWNER_ID || db.admins.includes(id);
}

// ================= HELPERS =================
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// HTML entity decode (&zwnj; &shy; &#8204; &#x200c; &amp;zwnj; — sob)
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  zwnj: '', zwj: '', shy: '', lrm: '', rlm: '', ensp: ' ', emsp: ' ', thinsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®', trade: '™',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„',
  bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢',
  laquo: '«', raquo: '»', deg: '°', times: '×', divide: '÷', para: '¶', sect: '§',
};

function decodeEntities(str) {
  let s = String(str);
  // 3 bar porjonto loop — double encoded (&amp;zwnj;) o thik hobe
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
        try {
          return String.fromCodePoint(code);
        } catch (e) {
          return '';
        }
      }
      const v = NAMED_ENTITIES[ent.toLowerCase()];
      return v !== undefined ? v : m;
    });
    if (s === before) break;
  }
  return s;
}

// Invisible / zero-width character remove
function cleanInvisible(str) {
  return String(str)
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\u3164\uFEFF\uFFA0]/g, '');
}

// Ek line er text (subject / from) clean
function cleanLine(str) {
  return cleanInvisible(decodeEntities(str || '')).replace(/\s+/g, ' ').trim();
}

function htmlToText(html) {
  let s = String(html)
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s);
  s = cleanInvisible(s);

  return s
    .split('\n')
    .map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractOtp(subject, body) {
  const text = (subject || '') + '\n' + (body || '');
  const keyword = text.match(/(?:code|otp|pin|passcode|verification|verify|confirm)[^0-9]{0,40}(\d{4,8})/i);
  if (keyword) return keyword[1];
  const split = text.match(/\b(\d{3})[\s-](\d{3})\b/);
  if (split) return split[1] + split[2];
  const any = text.match(/\b(\d{4,8})\b/);
  if (any) return any[1];
  return null;
}

// Shudhu Telegram error er status code (axios error na)
function tgCode(e) {
  return e && e.code === 'ETELEGRAM' && e.response ? e.response.statusCode : null;
}

function short(x) {
  try {
    return (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300);
  } catch (e) {
    return String(x).slice(0, 300);
  }
}

async function editMenu(chatId, msgId, text, kb) {
  const opts = { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true };
  try {
    await bot.editMessageText(text, Object.assign({ chat_id: chatId, message_id: msgId }, opts));
  } catch (e) {
    if (!String(e.message).includes('not modified')) await bot.sendMessage(chatId, text, opts).catch(() => {});
  }
}

// ================= FORCE JOIN =================
async function getNotJoined(userId) {
  const missing = [];
  for (const ch of db.channels) {
    try {
      const m = await bot.getChatMember(ch.id, userId);
      const ok =
        ['member', 'administrator', 'creator'].includes(m.status) ||
        (m.status === 'restricted' && m.is_member);
      if (!ok) missing.push(ch);
    } catch (e) {
      console.error('Join check failed for', ch.id, e.message);
    }
  }
  return missing;
}

function joinKeyboard(channels) {
  const rows = channels.map((ch) => [{ text: '📢 Join ' + ch.title, url: ch.link }]);
  rows.push([{ text: '✅ I Joined', callback_data: 'check_join' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

async function ensureJoined(chatId, userId) {
  if (isAdmin(userId) || db.channels.length === 0) return true;
  const missing = await getNotJoined(userId);
  if (missing.length === 0) return true;
  await bot.sendMessage(chatId, '🔒 Please join our channel(s) first to use this bot.', joinKeyboard(missing));
  return false;
}

// ================= Emailnator (Gmail) — new /api =================
let enCookies = {};
let enWarmAt = 0;
let enLoggedList = false;
let enMsgMode = null; // kon message endpoint kaj kore seta mone rakhe

function storeCookies(res) {
  const list = (res && res.headers && res.headers['set-cookie']) || [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) enCookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

function enHeaders() {
  const h = {
    'User-Agent': UA,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: EN_BASE,
    Referer: EN_BASE + '/',
  };
  const c = Object.entries(enCookies)
    .map(([k, v]) => k + '=' + v)
    .join('; ');
  if (c) h.Cookie = c;
  return h;
}

async function enWarm() {
  if (Date.now() - enWarmAt < 20 * 60 * 1000) return;
  try {
    const res = await axios.get(EN_BASE + '/', {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      timeout: 20000,
      validateStatus: () => true,
    });
    storeCookies(res);
  } catch (e) {}
  enWarmAt = Date.now();
}

async function enRequest(method, url, body) {
  await enWarm();
  const res = await axios({
    method,
    url: EN_BASE + url,
    data: body,
    headers: enHeaders(),
    timeout: 20000,
    validateStatus: () => true,
  });
  storeCookies(res);
  const data = res.data;
  if (res.status >= 400 || (data && typeof data === 'object' && data.status === 'error')) {
    const msg = (data && (data.message || data.error)) || 'HTTP ' + res.status;
    const err = new Error('Emailnator ' + url + ' -> ' + msg);
    err.raw = short(data);
    throw err;
  }
  return data;
}

function findEmail(obj, depth = 0) {
  if (depth > 5 || obj == null) return null;
  if (typeof obj === 'string') return /^[^\s@]+@(gmail|googlemail)\.com$/i.test(obj.trim()) ? obj.trim() : null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const r = findEmail(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const r = findEmail(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function findArray(obj, depth = 0) {
  if (depth > 4 || obj == null) return null;
  if (Array.isArray(obj)) return obj;
  if (typeof obj === 'object') {
    for (const k of ['messages', 'messageData', 'data', 'items', 'list', 'emails']) {
      if (Array.isArray(obj[k])) return obj[k];
    }
    for (const v of Object.values(obj)) {
      const r = findArray(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function pickBody(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj;
  for (const k of ['html', 'htmlBody', 'body', 'content', 'text', 'textBody', 'message']) {
    if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k];
  }
  if (obj.data && typeof obj.data === 'object') return pickBody(obj.data);
  if (typeof obj.data === 'string') return obj.data;
  return null;
}

function fromText(f) {
  if (!f) return 'unknown';
  if (typeof f === 'string') return cleanLine(f) || 'unknown';
  return cleanLine(f.address || f.email || f.name || '') || 'unknown';
}

// Emailnator er "Locked sender / Upgrade to Premium" fake mail skip
function isLockedMail(m) {
  const r = m.raw || {};
  if (r.locked === true || r.isLocked === true || r.premium === true || r.isPremium === true) return true;
  const t = (m.from + ' ' + m.subject).toLowerCase();
  return t.includes('locked sender') || t.includes('upgrade to premium');
}

// Same mail duibar na ashar jonno stable key
function mailKey(m) {
  const r = m.raw || {};
  const time = r.time || r.date || r.createdAt || r.created_at || r.receivedAt || '';
  return m.from + '|' + m.subject + '|' + time;
}

async function gmailGenerate() {
  const data = await enRequest('post', '/api/generate-email', { ids: [EN_TYPE_ID] });
  const address = findEmail(data);
  if (!address) {
    const err = new Error('Gmail generate: email paoa jayni');
    err.raw = short(data);
    throw err;
  }
  return address;
}

async function gmailInbox(address) {
  const data = await enRequest('post', '/api/message-list', { email: address, limit: 20 });
  const arr = findArray(data);
  if (!arr) {
    if (!enLoggedList) {
      enLoggedList = true;
      console.log('Emailnator list raw:', short(data));
    }
    return [];
  }
  return arr
    .map((m) => ({
      id: String(m.id || m.messageID || m.messageId || m._id || m.uid || ''),
      from: fromText(m.from || m.sender || m.fromAddress),
      subject: cleanLine(m.subject) || '(no subject)',
      raw: m,
    }))
    .filter((m) => m.id && m.id !== 'ADSVPN' && !isLockedMail(m));
}

async function gmailBody(address, m) {
  const own = pickBody(m.raw);
  if (own && own.length > 40) return htmlToText(own);

  const id = encodeURIComponent(m.id);
  const em = encodeURIComponent(address);
  const tries = {
    a: () => enRequest('get', '/api/message/' + id + '?email=' + em),
    b: () => enRequest('get', '/api/messages/' + id + '?email=' + em),
    c: () => enRequest('post', '/api/message', { email: address, messageID: m.id }),
    d: () => enRequest('post', '/api/message', { email: address, id: m.id }),
  };
  const order = enMsgMode ? [enMsgMode] : Object.keys(tries);

  for (const key of order) {
    try {
      const data = await tries[key]();
      const b = pickBody(data);
      if (b) {
        if (!enMsgMode) console.log('Emailnator message endpoint works: ' + key);
        enMsgMode = key;
        return htmlToText(b);
      }
    } catch (e) {
      if (enMsgMode) console.error('Gmail body error:', e.message);
    }
  }
  return htmlToText(own || m.subject || '(no content)');
}

// ================= MAILBOX =================
// mb = { address, seen, timer, stopAt, busy }
function markSeen(mb, m) {
  mb.seen.add('id:' + m.id);
  mb.seen.add('k:' + mailKey(m));
}
function isSeen(mb, m) {
  return mb.seen.has('id:' + m.id) || mb.seen.has('k:' + mailKey(m));
}

async function createMailbox() {
  const mb = { address: await gmailGenerate(), seen: new Set(), timer: null, stopAt: 0, busy: false };
  try {
    (await gmailInbox(mb.address)).forEach((m) => markSeen(mb, m)); // purono mail skip
  } catch (e) {}
  return mb;
}

async function fetchNewMails(mb) {
  const out = [];
  const list = (await gmailInbox(mb.address)).reverse();
  for (const m of list) {
    if (isSeen(mb, m)) continue;
    markSeen(mb, m);
    const body = await gmailBody(mb.address, m);
    out.push({ from: m.from, subject: m.subject, body: body || '(no content)' });
  }
  return out;
}

// ================= USER KEYBOARDS =================
function mainMenuKeyboard() {
  return { reply_markup: { inline_keyboard: [[{ text: '📧 Generate Email', callback_data: 'generate' }]] } };
}

function mailKeyboard(address) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: address, copy_text: { text: address } }],
        [{ text: '🔄 New Email', callback_data: 'generate' }],
      ],
    },
  };
}

function otpKeyboard(otp) {
  return { reply_markup: { inline_keyboard: [[{ text: otp, copy_text: { text: otp } }]] } };
}

// ================= MAIL POLLING =================
const userMailboxes = new Map(); // chatId -> mb

async function sendMail(chatId, mail) {
  const otp = extractOtp(mail.subject, mail.body);
  let body = String(mail.body || '').trim() || '(no content)';
  if (body.length > 800) body = body.slice(0, 800).trim() + '…';

  const msgText =
    '📩 <b>New Mail</b>\n\n' +
    '<b>From:</b> ' + escapeHtml(mail.from) + '\n' +
    '<b>Subject:</b> ' + escapeHtml(mail.subject) + '\n\n' +
    escapeHtml(body);

  const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
  if (otp) Object.assign(opts, otpKeyboard(otp));
  await bot.sendMessage(chatId, msgText, opts);

  db.stats.mails++;
  saveDb();
}

function stopPolling(chatId) {
  const mb = userMailboxes.get(chatId);
  if (mb && mb.timer) {
    clearInterval(mb.timer);
    mb.timer = null;
  }
}

function startPolling(chatId) {
  const mb = userMailboxes.get(chatId);
  if (!mb) return;
  stopPolling(chatId);
  mb.stopAt = Date.now() + POLL_DURATION_MS;

  mb.timer = setInterval(async () => {
    if (userMailboxes.get(chatId) !== mb) return;

    if (Date.now() > mb.stopAt) {
      stopPolling(chatId);
      bot
        .sendMessage(chatId, '⏱ This email has expired.\nTap the button below to get a new one.', mainMenuKeyboard())
        .catch(() => {});
      return;
    }

    if (mb.busy) return;
    mb.busy = true;
    try {
      const mails = await fetchNewMails(mb);
      for (const mail of mails) await sendMail(chatId, mail);
    } catch (err) {
      if (tgCode(err) === 403) {
        stopPolling(chatId);
        if (db.users[String(chatId)]) {
          db.users[String(chatId)].blocked = true;
          saveDb();
        }
      } else {
        console.error('Poll error (' + chatId + '):', err.message, err.raw || '');
      }
    } finally {
      mb.busy = false;
    }
  }, POLL_INTERVAL_MS);
}

// ================= ADMIN PANEL =================
const adminState = new Map(); // userId -> 'add_channel' | 'add_admin' | 'broadcast'

function adminHomeKb() {
  return {
    inline_keyboard: [
      [{ text: '📊 User Stats', callback_data: 'adm:stats' }, { text: '📢 Join Channels', callback_data: 'adm:ch' }],
      [{ text: '👮 Admins', callback_data: 'adm:ad' }, { text: '📣 Broadcast', callback_data: 'adm:bc' }],
    ],
  };
}
const ADMIN_HOME_TEXT = '🛠 <b>Admin Panel</b>\n\nChoose an option below:';

function backKb(to) {
  return { inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'adm:' + to }]] };
}
function cancelKb(to) {
  return { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'adm:cancel:' + to }]] };
}

function statsView() {
  const users = Object.entries(db.users);
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const total = users.length;
  const today = users.filter(([, u]) => u.joined >= dayStart.getTime()).length;
  const active24 = users.filter(([, u]) => u.last >= now - 86400000).length;
  const active7 = users.filter(([, u]) => u.last >= now - 7 * 86400000).length;
  const blocked = users.filter(([, u]) => u.blocked).length;
  let live = 0;
  for (const mb of userMailboxes.values()) if (mb.timer) live++;

  const recent =
    users
      .sort((a, b) => b[1].joined - a[1].joined)
      .slice(0, 5)
      .map(
        ([id, u]) =>
          '• ' + escapeHtml(u.name) + (u.username ? ' @' + escapeHtml(u.username) : '') + ' — <code>' + id + '</code>'
      )
      .join('\n') || '—';

  const text =
    '📊 <b>User Stats</b>\n\n' +
    '👥 Total users: <b>' + total + '</b>\n' +
    '🆕 New today: <b>' + today + '</b>\n' +
    '🟢 Active (24h): <b>' + active24 + '</b>\n' +
    '📅 Active (7 days): <b>' + active7 + '</b>\n' +
    '🚫 Blocked bot: <b>' + blocked + '</b>\n\n' +
    '📧 Emails generated: <b>' + db.stats.emails + '</b>\n' +
    '📩 Mails received: <b>' + db.stats.mails + '</b>\n' +
    '⚡ Live inboxes now: <b>' + live + '</b>\n\n' +
    '🕒 <b>Latest users:</b>\n' + recent;

  return {
    text,
    kb: {
      inline_keyboard: [
        [{ text: '🔄 Refresh', callback_data: 'adm:stats' }],
        [{ text: '⬅️ Back', callback_data: 'adm:home' }],
      ],
    },
  };
}

function channelsView() {
  let text = '📢 <b>Force Join Channels</b>\n\n';
  if (!db.channels.length) {
    text += 'No channel set. Users can use the bot without joining.';
  } else {
    db.channels.forEach((c, i) => {
      text += (i + 1) + '. <b>' + escapeHtml(c.title) + '</b>\n<code>' + c.id + '</code>\n' + escapeHtml(c.link) + '\n\n';
    });
  }
  const rows = db.channels.map((c, i) => [{ text: '❌ Remove ' + c.title, callback_data: 'adm:chdel:' + i }]);
  rows.push([{ text: '➕ Add Channel', callback_data: 'adm:chadd' }]);
  rows.push([{ text: '⬅️ Back', callback_data: 'adm:home' }]);
  return { text, kb: { inline_keyboard: rows } };
}

function adminsView(viewerId) {
  let text = '👮 <b>Admins</b>\n\n👑 Owner: <code>' + OWNER_ID + '</code>\n';
  if (db.admins.length) {
    text += '\n' + db.admins.map((id, i) => (i + 1) + '. <code>' + id + '</code>').join('\n');
  } else {
    text += '\nNo extra admin added.';
  }
  const rows = [];
  if (isOwner(viewerId)) {
    db.admins.forEach((id) => rows.push([{ text: '❌ Remove ' + id, callback_data: 'adm:addel:' + id }]));
    rows.push([{ text: '➕ Add Admin', callback_data: 'adm:adadd' }]);
  } else {
    text += '\n\n<i>Only the owner can add/remove admins.</i>';
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'adm:home' }]);
  return { text, kb: { inline_keyboard: rows } };
}

async function handleAdminCallback(query) {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const userId = query.from.id;
  const [, action, arg] = query.data.split(':');

  if (!isAdmin(userId)) {
    await bot.answerCallbackQuery(query.id, { text: '⛔ Admin only', show_alert: true });
    return;
  }
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (action === 'home') {
    adminState.delete(userId);
    return editMenu(chatId, msgId, ADMIN_HOME_TEXT, adminHomeKb());
  }

  if (action === 'cancel') {
    adminState.delete(userId);
    const v = arg === 'ch' ? channelsView() : arg === 'ad' ? adminsView(userId) : null;
    if (v) return editMenu(chatId, msgId, v.text, v.kb);
    return editMenu(chatId, msgId, ADMIN_HOME_TEXT, adminHomeKb());
  }

  if (action === 'stats') {
    const v = statsView();
    return editMenu(chatId, msgId, v.text, v.kb);
  }

  if (action === 'ch') {
    const v = channelsView();
    return editMenu(chatId, msgId, v.text, v.kb);
  }

  if (action === 'chadd') {
    adminState.set(userId, 'add_channel');
    return editMenu(
      chatId,
      msgId,
      '➕ <b>Add Join Channel</b>\n\n' +
        '1. Age bot ke channel e <b>admin</b> banan.\n' +
        '2. Tarpor ekhane pathan:\n\n' +
        'Public channel:\n<code>@YourChannel</code>\n\n' +
        'Private channel (ID + invite link):\n<code>-1001234567890 https://t.me/+xxxx</code>',
      cancelKb('ch')
    );
  }

  if (action === 'chdel') {
    const i = Number(arg);
    if (db.channels[i]) {
      db.channels.splice(i, 1);
      saveDb();
    }
    const v = channelsView();
    return editMenu(chatId, msgId, v.text, v.kb);
  }

  if (action === 'ad') {
    const v = adminsView(userId);
    return editMenu(chatId, msgId, v.text, v.kb);
  }

  if (action === 'adadd') {
    if (!isOwner(userId)) return;
    adminState.set(userId, 'add_admin');
    return editMenu(
      chatId,
      msgId,
      '➕ <b>Add Admin</b>\n\nNotun admin er Telegram user ID pathan (number only).\n\nExample: <code>123456789</code>',
      cancelKb('ad')
    );
  }

  if (action === 'addel') {
    if (!isOwner(userId)) return;
    db.admins = db.admins.filter((id) => id !== Number(arg));
    saveDb();
    const v = adminsView(userId);
    return editMenu(chatId, msgId, v.text, v.kb);
  }

  if (action === 'bc') {
    adminState.set(userId, 'broadcast');
    return editMenu(
      chatId,
      msgId,
      '📣 <b>Broadcast</b>\n\nJe message ta sob user ke pathate chan seta ekhane pathan (text, photo, video — sob cholbe).',
      cancelKb('home')
    );
  }
}

async function addChannel(chatId, text) {
  const [ref, linkArg] = text.trim().split(/\s+/);
  let chat;
  try {
    chat = await bot.getChat(ref);
  } catch (e) {
    return bot.sendMessage(
      chatId,
      '❌ Channel paoa jayni. Username/ID thik ache kina ar bot channel e admin kina check korun.',
      { reply_markup: backKb('ch') }
    );
  }

  try {
    const me = await bot.getChatMember(chat.id, BOT_ID);
    if (!['administrator', 'creator'].includes(me.status)) throw new Error('not admin');
  } catch (e) {
    return bot.sendMessage(chatId, '❌ Bot ei channel e admin na. Age bot ke admin banan.', {
      reply_markup: backKb('ch'),
    });
  }

  if (db.channels.some((c) => String(c.id) === String(chat.id))) {
    return bot.sendMessage(chatId, '⚠️ Ei channel already add kora ache.', { reply_markup: backKb('ch') });
  }

  let link = chat.username ? 'https://t.me/' + chat.username : linkArg || chat.invite_link;
  if (!link) {
    try {
      link = await bot.exportChatInviteLink(chat.id);
    } catch (e) {}
  }
  if (!link) {
    return bot.sendMessage(chatId, '❌ Invite link paoa jayni. ID er sathe link o pathan:\n<code>-100xxxx https://t.me/+xxxx</code>', {
      parse_mode: 'HTML',
      reply_markup: backKb('ch'),
    });
  }

  db.channels.push({ id: chat.id, title: chat.title || ref, link });
  saveDb();
  const v = channelsView();
  return bot.sendMessage(chatId, '✅ Channel added!\n\n' + v.text, {
    parse_mode: 'HTML',
    reply_markup: v.kb,
    disable_web_page_preview: true,
  });
}

async function addAdmin(chatId, text) {
  const id = Number(text.trim());
  if (!Number.isInteger(id) || id <= 0) {
    return bot.sendMessage(chatId, '❌ Valid numeric user ID pathan.', { reply_markup: backKb('ad') });
  }
  if (isAdmin(id)) {
    return bot.sendMessage(chatId, '⚠️ Ei user already admin.', { reply_markup: backKb('ad') });
  }
  db.admins.push(id);
  saveDb();
  bot.sendMessage(id, '🎉 You are now an admin of this bot. Use /admin').catch(() => {});
  const v = adminsView(OWNER_ID);
  return bot.sendMessage(chatId, '✅ Admin added!\n\n' + v.text, { parse_mode: 'HTML', reply_markup: v.kb });
}

async function broadcast(adminChatId, fromChatId, messageId) {
  const ids = Object.keys(db.users).filter((id) => !db.users[id].blocked);
  let ok = 0;
  let fail = 0;
  const status = await bot.sendMessage(adminChatId, '📣 Broadcasting to ' + ids.length + ' users...');

  for (const id of ids) {
    try {
      await bot.copyMessage(id, fromChatId, messageId);
      ok++;
    } catch (e) {
      fail++;
      if (tgCode(e) === 403 && db.users[id]) db.users[id].blocked = true;
    }
    await sleep(50);
  }
  saveDb();

  bot
    .editMessageText('✅ Broadcast done\n\n📤 Sent: ' + ok + '\n❌ Failed: ' + fail, {
      chat_id: adminChatId,
      message_id: status.message_id,
      reply_markup: backKb('home'),
    })
    .catch(() => {});
}

// ================= COMMANDS =================
const WELCOME =
  '🌐 Welcome to TH Temp Mail!\n\n📧 Generate a temporary email address instantly and use it whenever you need.\n\n👇 Tap the button below to get your temporary email.';

bot.onText(/^\/start/, async (msg) => {
  try {
    if (msg.chat.type !== 'private') return;
    trackUser(msg.from);
    if (!(await ensureJoined(msg.chat.id, msg.from.id))) return;
    await bot.sendMessage(msg.chat.id, WELCOME, mainMenuKeyboard());
  } catch (e) {
    console.error('/start error:', e.message);
  }
});

bot.onText(/^\/admin/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  if (!isAdmin(msg.from.id)) return;
  adminState.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, ADMIN_HOME_TEXT, { parse_mode: 'HTML', reply_markup: adminHomeKb() }).catch(() => {});
});

bot.onText(/^\/cancel/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  adminState.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, '❌ Cancelled.', { reply_markup: adminHomeKb() }).catch(() => {});
});

// Admin input (channel / admin id / broadcast message)
bot.on('message', async (msg) => {
  if (msg.chat.type !== 'private') return;
  const state = adminState.get(msg.from.id);
  if (!state || !isAdmin(msg.from.id)) return;
  if (msg.text && msg.text.startsWith('/')) return;

  adminState.delete(msg.from.id);
  try {
    if (state === 'add_channel') {
      if (!msg.text) return bot.sendMessage(msg.chat.id, '❌ Text pathan.', { reply_markup: backKb('ch') });
      await addChannel(msg.chat.id, msg.text);
    } else if (state === 'add_admin') {
      if (!msg.text) return bot.sendMessage(msg.chat.id, '❌ Text pathan.', { reply_markup: backKb('ad') });
      await addAdmin(msg.chat.id, msg.text);
    } else if (state === 'broadcast') {
      broadcast(msg.chat.id, msg.chat.id, msg.message_id).catch((e) => console.error('Broadcast error:', e.message));
    }
  } catch (e) {
    console.error('Admin input error:', e.message);
    bot.sendMessage(msg.chat.id, '❌ Error: ' + e.message).catch(() => {});
  }
});

// ================= CALLBACKS =================
async function handleGenerate(chatId, userId) {
  stopPolling(chatId);
  const wait = await bot.sendMessage(chatId, '⏳ Generating your email...').catch(() => null);

  let mb;
  try {
    mb = await createMailbox();
  } catch (e) {
    console.error('Generate error (gmail):', e.message, e.raw || '');
    await bot.sendMessage(chatId, '❌ Email service is busy right now. Please try again in a minute.', mainMenuKeyboard());
    return;
  } finally {
    if (wait) bot.deleteMessage(chatId, wait.message_id).catch(() => {});
  }

  userMailboxes.set(chatId, mb);
  db.stats.emails++;
  if (db.users[String(userId)]) db.users[String(userId)].emails++;
  saveDb();

  await bot.sendMessage(
    chatId,
    '✅ Your temporary Gmail is ready!\n\n' +
      'Use it for signups, verifications, or anywhere you would rather not use your real email.\n\n' +
      '⚡ New mails and OTP codes will appear here automatically.\n\n' +
      '👇 Tap the email to copy it.',
    mailKeyboard(mb.address)
  );
  startPolling(chatId);
}

bot.on('callback_query', async (query) => {
  if (!query.message) return;
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data || '';

  try {
    if (data.startsWith('adm:')) return await handleAdminCallback(query);

    await bot.answerCallbackQuery(query.id).catch(() => {});
    trackUser(query.from);

    if (data === 'check_join') {
      const missing = isAdmin(userId) ? [] : await getNotJoined(userId);
      if (missing.length) {
        await bot.sendMessage(chatId, '❌ You have not joined all channels yet.', joinKeyboard(missing));
        return;
      }
      await bot.sendMessage(chatId, WELCOME, mainMenuKeyboard());
      return;
    }

    if (!(await ensureJoined(chatId, userId))) return;

    // purono sob button (generate, gen:gmail, gen:mailtm, gen:other) ek kaj kore
    if (data === 'generate' || data.startsWith('gen:')) return await handleGenerate(chatId, userId);
  } catch (err) {
    console.error('Callback error:', err.message, err.raw || '');
    bot.sendMessage(chatId, 'Something went wrong. Please try again.').catch(() => {});
  }
});

bot.on('polling_error', (e) => console.error('Polling error:', e.code, e.message));

bot
  .getMe()
  .then((me) => {
    BOT_ID = me.id;
    console.log('Temp Mail Bot running as @' + me.username);
  })
  .catch((e) => {
    console.error('getMe failed:', e.message);
    process.exit(1);
  });
