const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const BOT_TOKEN = '8855250275:AAG0NFefUt19zkV5qQdLAP6H85phKiQbDM4';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const userMailboxes = new Map();
const API_BASE = 'https://api.mail.tm';

const CHANNEL_USERNAME = '@TH_NumberPanel';

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
        [{ text: 'I Joined', callback_data: 'check_join' }]
      ]
    }
  };
}

async function generateMailbox() {
  const { data: domains } = await axios.get(API_BASE + '/domains');
  const domain = domains['hydra:member'][0].domain;
  const login = 'user' + Math.random().toString(36).substring(2, 10);
  const address = login + '@' + domain;
  const password = 'Pass' + Math.random().toString(36).substring(2, 10);

  await axios.post(API_BASE + '/accounts', { address: address, password: password });
  const { data: tokenData } = await axios.post(API_BASE + '/token', { address: address, password: password });

  return { address: address, token: tokenData.token };
}

async function getInbox(token) {
  const { data } = await axios.get(API_BASE + '/messages', {
    headers: { Authorization: 'Bearer ' + token },
  });
  return data['hydra:member'];
}

async function getMessageBody(token, id) {
  const { data } = await axios.get(API_BASE + '/messages/' + id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  return data;
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Generate Email', callback_data: 'generate' }]],
    },
  };
}

function mailKeyboardWithCopy(address) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'copy', copy_text: { text: address } }],
        [{ text: 'inbox', callback_data: 'inbox' }],
      ],
    },
  };
}

function inboxOnlyKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'inbox', callback_data: 'inbox' }],
      ],
    },
  };
}

async function sendInbox(chatId, token, address) {
  const messages = await getInbox(token);

  if (!messages.length) {
    await bot.sendMessage(
      chatId,
      '📭 No messages yet.\n\n🔄 Tap Inbox to refresh.',
      inboxOnlyKeyboard()
    );
    return;
  }

  const latest = messages.slice(0, 5);

  for (const m of latest) {
    const full = await getMessageBody(token, m.id);
    const body = (full.text || full.html || '(no content)').toString().slice(0, 500);

    const msgText =
      'From: ' + full.from.address + '\n' +
      'Subject: ' + full.subject + '\n\n' +
      body;

    await bot.sendMessage(chatId, msgText);
  }

  await bot.sendMessage(chatId, 'Above are your latest messages.', inboxOnlyKeyboard());
}

bot.onText(/\/start/, async function (msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const member = await isUserMember(userId);

  if (!member) {
    await bot.sendMessage(
      chatId,
      '🔒 Please join our channel first to use this bot.',
      joinChannelKeyboard()
    );
    return;
  }

  bot.sendMessage(
    chatId,
    '🌐 Welcome to TH Temp Mail!\n\n📧 Generate a temporary email address instantly and use it whenever you need.\n\n👇 Tap the button below to get your temporary email.',
    mainMenuKeyboard()
  );
});

bot.on('callback_query', async function (query) {
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
      await bot.sendMessage(
        chatId,
        '🌐 Welcome to TH Temp Mail!\n\n📧 Generate a temporary email address instantly and use it whenever you need.\n\n👇 Tap the button below to get your temporary email.',
        mainMenuKeyboard()
      );
      return;
    }

    const member = await isUserMember(userId);
    if (!member) {
      await bot.sendMessage(chatId, '🔒 Please join our channel first to use this bot.', joinChannelKeyboard());
      return;
    }

    if (data === 'generate') {
      const result = await generateMailbox();
      const address = result.address;
      const token = result.token;
      userMailboxes.set(chatId, { token: token, address: address });

      await bot.sendMessage(
        chatId,
        'Use it for signups, verifications, or anywhere you would rather not use your real email.\n\n' +
          'Tap the Inbox button below anytime to check for new mails.\n\n' +
          'email : ' + address,
        mailKeyboardWithCopy(address)
      );
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