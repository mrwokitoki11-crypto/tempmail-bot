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
      inline_keyboard: [[{ text: '📧 Generate Email', callback_data: 'generate' }]],
    },
  };
}

function mailKeyboard(address) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 copy', callback_data: `copy_${address}` }],
        [{ text: '📥 inbox', callback_data: 'inbox' }],
      ],
    },
  };
}

async function sendInbox(chatId, token, address) {
  const messages = await getInbox(token);

  if (!messages.length) {
    await bot.sendMessage(
      chatId,
      '📭 Inbox is empty. Tap Inbox again to refresh.',
      mailKeyboard(address)
    );
    return;
  }

  const latest = messages.slice(0, 5);

  for (const m of latest) {
    const full = await getMessageBody(token, m.id);
    const body = (full.text || full.html || '(no content)').toString().slice(0, 500);

    const msgText =
      `👤 *From:* ${full.from.address}\n` +
      `📝 *Subject:* ${full.subject}\n\n` +
      `${body}`;

    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
  }

  await bot.sendMessage(chatId, '👆 Above are your latest messages.', mailKeyboard(address));
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
      userMailboxes.set(chatId, { token, address });

      await bot.sendMessage(
        chatId,
        `Use it for signups, verifications, or anywhere you'd rather not use your real email.\n\n` +
          `Tap the Inbox button below anytime to check for new mails.\n\n` +
          `email : \`${address}\``,
        { parse_mode: 'Markdown', ...mailKeyboard(address) }
      );
    } else if (data === 'inbox') {
      const mailbox = userMailboxes.get(chatId);
      if (!mailbox) {
        await bot.sendMessage(chatId, 'Generate a mail first!', mainMenuKeyboard());
        return;
      }
      await sendInbox(chatId, mailbox.token, mailbox.address);
    } else if (data.startsWith('copy_')) {
      const address = data.replace('copy_', '');
      await bot.sendMessage(chatId, `\`${address}\``, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
  }
});

console.log('Temp Mail Bot is running...');
