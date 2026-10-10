const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Railway > Variables e BOT_TOKEN set kora ache
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN environment variable is missing!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const API_BASE = 'https://api.mail.tm';
const CHANNEL_USERNAME = '@TH_NumberPanel';

const POLL_INTERVAL_MS = 5000;           // proti 5 second e inbox check
const POLL_DURATION_MS = 30 * 60 * 1000; // 30 minute porjonto auto check

const userMailboxes = new Map(); // chatId -> { token, address, seen:Set, timer, stopAt, busy }

// ---------------- Channel join check ----------------
async function isUserMember(userId) {
  try {
    const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.error('Membership check failed:', err.message);
    return false;
  }
}

function joinChannelKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Join Channel', url: 'https://t.me/' + CHANNEL_USERNAME.replace('@', '') }],
        [{ text: 'I Joined', callback_data: 'check_join' }],
      ],
    },
  };
}

// ---------------- mail.tm API ----------------
async function generateMailbox() {
  const { data: domains } = await axios.get(API_BASE + '/domains');
  const domain = domains['hydra:member'][0].domain;
  const login = 'user' + Math.random().toString(36).substring(2, 10);
  const address = login + '@' + domain;
  const password = 'Pass' + Math.random().toString(36).substring(2, 10);

  await axios.post(API_BASE + '/accounts', { address, password });
  const { data: tokenData } = await axios.post(API_BASE + '/token', { address, password });

  return { address, token: tokenData.token };
}

async function getInbox(token) {
  const { data } = await axios.get(API_BASE + '/messages', {
    headers: { Authorization: 'Bearer ' + token },
  });
  return data['hydra:member'] || [];
}

async function getMessageBody(token, id) {
  const { data } = await axios.get(API_BASE + '/messages/' + id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  return data;
}

// ---------------- Helpers ----------------
function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function getPlainBody(full) {
  if (full.text && String(full.text).trim()) return String(full.text).trim();
  if (full.html) {
    const html = Array.isArray(full.html) ? full.html.join('\n') : full.html;
    return htmlToText(html);
  }
  return '(no content)';
}

function extractOtp(subject, body) {
  const text = (subject || '') + '\n' + (body || '');

  // 1) "code / otp / pin / verification" er kache thaka number
  const keyword = text.match(
    /(?:code|otp|pin|passcode|verification|verify|confirm)[^0-9]{0,40}(\d{4,8})/i
  );
  if (keyword) return keyword[1];

  // 2) "123 456" ba "123-456" type code
  const split = text.match(/\b(\d{3})[\s-](\d{3})\b/);
  if (split) return split[1] + split[2];

  // 3) je kono 4-8 digit er number
  const any = text.match(/\b(\d{4,8})\b/);
  if (any) return any[1];

  return null;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------- Keyboards ----------------
function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Generate Email', callback_data: 'generate' }]],
    },
  };
}

// Button e email tai lekha thakbe, tap korle copy
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

// Button e OTP code tai lekha thakbe, tap korle copy
function otpKeyboard(otp) {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: otp, copy_text: { text: otp } }]],
    },
  };
}

// ---------------- Send one mail ----------------
async function sendMail(chatId, token, m) {
  const full = await getMessageBody(token, m.id);
  const body = getPlainBody(full);
  const otp = extractOtp(full.subject, body);

  let msgText =
    '📩 <b>New Mail</b>\n\n' +
    '<b>From:</b> ' + escapeHtml(full.from && full.from.address ? full.from.address : 'unknown') + '\n' +
    '<b>Subject:</b> ' + escapeHtml(full.subject || '(no subject)') + '\n\n' +
    escapeHtml(body.slice(0, 800));

  const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
  if (otp) Object.assign(opts, otpKeyboard(otp));

  await bot.sendMessage(chatId, msgText, opts);
}

// ---------------- Auto polling ----------------
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
    const current = userMailboxes.get(chatId);
    if (!current || current !== mb) return;

    if (Date.now() > mb.stopAt) {
      stopPolling(chatId);
      bot.sendMessage(
        chatId,
        '⏱ This email has expired.\nTap the button below to get a new one.',
        mainMenuKeyboard()
      ).catch(() => {});
      return;
    }

    if (mb.busy) return;
    mb.busy = true;
    try {
      const messages = await getInbox(mb.token);
      const fresh = messages.filter((m) => !mb.seen.has(m.id)).reverse(); // purono theke notun
      for (const m of fresh) {
        mb.seen.add(m.id);
        await sendMail(chatId, mb.token, m);
      }
    } catch (err) {
      console.error('Poll error (' + chatId + '):', err.message);
    } finally {
      mb.busy = false;
    }
  }, POLL_INTERVAL_MS);
}

// ---------------- Commands ----------------
const WELCOME =
  '🌐 Welcome to TH Temp Mail!\n\n📧 Generate a temporary email address instantly and use it whenever you need.\n\n👇 Tap the button below to get your temporary email.';

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const member = await isUserMember(msg.from.id);

  if (!member) {
    await bot.sendMessage(chatId, '🔒 Please join our channel first to use this bot.', joinChannelKeyboard());
    return;
  }
  bot.sendMessage(chatId, WELCOME, mainMenuKeyboard());
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);

    if (data === 'check_join') {
      const member = await isUserMember(userId);
      if (!member) {
        await bot.sendMessage(chatId, '❌ You have not joined the channel yet.', joinChannelKeyboard());
        return;
      }
      await bot.sendMessage(chatId, WELCOME, mainMenuKeyboard());
      return;
    }

    const member = await isUserMember(userId);
    if (!member) {
      await bot.sendMessage(chatId, '🔒 Please join our channel first to use this bot.', joinChannelKeyboard());
      return;
    }

    if (data === 'generate') {
      stopPolling(chatId);
      const { address, token } = await generateMailbox();
      userMailboxes.set(chatId, { token, address, seen: new Set(), timer: null, stopAt: 0, busy: false });

      await bot.sendMessage(
        chatId,
        '✅ Your temporary email is ready!\n\n' +
          'Use it for signups, verifications, or anywhere you would rather not use your real email.\n\n' +
          '⚡ New mails and OTP codes will appear here automatically.\n\n' +
          '👇 Tap the email to copy it.',
        mailKeyboard(address)
      );

      startPolling(chatId);
    }
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, 'Something went wrong. Please try again.');
  }
});

console.log('Temp Mail Bot is running...');
