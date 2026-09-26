const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const userMailboxes = new Map();
const API_BASE = 'https://api.mail.tm';

async function generateMailbox() {
  const res1 = await axios.get(API_BASE + '/domains');
  const domains = res1.data;
  const domain = domains['hydra:member'][0].domain;
  const login = 'user' + Math.random().toString(36).substring(2, 10);
  const address = login + '@' + domain;
  const password = 'Pass' + Math.random().toString(36).substring(2, 10);

  await axios.post(API_BASE + '/accounts', { address: address, password: password });
  const res2 = await axios.post(API_BASE + '/token', { address: address, password: password });
  const tokenData = res2.data;

  return { address: address, token: tokenData.token };
}

async function getInbox(token) {
  const res = await axios.get(API_BASE + '/messages', {
    headers: { Authorization: 'Bearer ' + token }
  });
  return res.data['hydra:member'];
}

async function getMessageBody(token, id) {
  const res = await axios.get(API_BASE + '/messages/' + id, {
    headers: { Authorization: 'Bearer ' + token }
  });
  return res.data;
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Generate Email', callback_data: 'generate' }]]
    }
  };
}

function mailKeyboard(address) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'copy', copy_text: { text: address } }],
        [{ text: 'inbox', callback_data: 'inbox' }]
      ]
    }
  };
}

async function sendInbox(chatId, token, address) {
  const messages = await getInbox(token);

  if (!messages.length) {
    await bot.sendMessage(chatId, 'Inbox is empty. Tap Inbox again to refresh.', mailKeyboard(address));
    return;
  }

  const latest = messages.slice(0, 5);

  for (let i = 0; i < latest.length; i++) {
    const m = latest[i];
    const full = await getMessageBody(token, m.id);
    const rawBody = full.text || full.html || '(no content)';
    const body = rawBody.toString().slice(0, 500);

    const msgText = 'From: ' + full.from.address + '\n' + 'Subject: ' + full.subject + '\n\n' + body;

    await bot.sendMessage(chatId, msgText);
  }

  await bot.sendMessage(chatId, 'Above are your latest messages.', mailKeyboard(address));
}

bot.onText(/\/start/, function (msg) {
  bot.sendMessage(msg.chat.id, 'Welcome to Temp Mail Bot! Tap the button below to generate a temporary email address.', mainMenuKeyboard());
});

bot.on('callback_query', async function (query) {
  const chatId = query.message.chat.id;
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);

    if (data === 'generate') {
      const result = await generateMailbox();
      const address = result.address;
      const token = result.token;
      userMailboxes.set(chatId, { token: token, address: address });

      await bot.sendMessage(chatId, 'Use it for signups and verifications. email : ' + address, mailKeyboard(address));
    } else if (data === 'inbox') {
      const mailbox = userMailboxes.get(chatId);
      if (!mailbox) {
        await bot.sendMessage(chatId, 'Generate a mail first!', mainMenuKeyboard());
        return;
      }
      await sendInbox(chatId, mailbox.token, mailbox.address);
    }
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, 'Something went wrong. Please try again.');
  }
});

console.log('Temp Mail Bot is running...');