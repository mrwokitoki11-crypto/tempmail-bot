const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const BOT_TOKEN = '8855250275:AAF3nx2OTbUMxOWUAMAj-mO-X-6MNm11HeI';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const userMailboxes = new Map();
const API_BASE = 'https://api.mail.tm';

async function generateMailbox() {
  const { data: domains } = await axios.get(`${API_BASE}/domains`);
  const domain = domains['hydra:member'][0].domain;
  const login = 'user' + Math.random().toString(36).substring(2, 10);
  const address = `${login}@${domain}`;
  const password = 'Pass' + Math.random().toString(36).substring(2, 10);

  await axios.post(`${API_BASE}/accounts`, { address, password });
  const { data: tokenData } = await axios.post(`${API_BASE}/token`, { address, password });

  return { address, token: tokenData.token };
}

async function getInbox(token) {
  const { data } = await axios.get(`${API_BASE}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data['hydra:member'];
}

async function getMessageBody(token, id) {
  const { data } = await axios.get(`${API_BASE}/messages/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: '📧 Generate Mail', callback_data: 'generate' }]],
    },
  };
}

function mailboxKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📥 Inbox', callback_data: 'inbox' }],
        [{ text: '🔄 Generate New Mail', callback_data: 'generate' }],
      ],
    },
  };
}

async function sendInbox(chatId, token) {
  const messages = await getInbox(token);

  if (!messages.length) {
    await bot.sendMessage(chatId, '📭 Inbox is empty. New mail will appear here — tap Inbox again to refresh.', mailboxKeyboard());
    return;
  }

  const latest = messages.slice(0, 5);
  let reply = `📥 *Inbox (${messages.length} message${messages.length > 1 ? 's' : ''})*\n\n`;

  for (const m of latest) {
    const full = await getMessageBody(token, m.id);
    const body = (full.text || full.html || '(no content)').toString().slice(0, 300);
    reply += `*From:* ${full.from.address}\n*Subject:* ${full.subject}\n\n${body}\n\n———\n\n`;
  }

  await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown', ...mailboxKeyboard() });
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    '👋 Welcome to Temp Mail Bot!\n\nTap the button below to generate a temporary email address.',
    mainMenuKeyboard()
  );
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);

    if (data === 'generate') {
      const { address, token } = await generateMailbox();
      userMailboxes.set(chatId, { token });

      await bot.sendMessage(
        chatId,
        `✅ Your temporary email:\n\n\`${address}\`\n\nChecking inbox...`,
        { parse_mode: 'Markdown' }
      );

      await sendInbox(chatId, token);
    } else if (data === 'inbox') {
      const mailbox = userMailboxes.get(chatId);
      if (!mailbox) {
        await bot.sendMessage(chatId, 'Generate a mail first!', mainMenuKeyboard());
        return;
      }
      await sendInbox(chatId, mailbox.token);
    }
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
  }
});

console.log('Temp Mail Bot is running...');
