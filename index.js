require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);

// In-memory state for multi-step flows
const userState = {};

// ─── helpers ────────────────────────────────────────────────────────────────

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

async function getUser(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  return data;
}

async function getRandomAd() {
  const { data } = await supabase
    .from('ads')
    .select('*')
    .eq('active', true);
  if (!data || data.length === 0) return null;
  return data[Math.floor(Math.random() * data.length)];
}

async function sendProfile(chatId, profile, extra = {}) {
  const genderLabel = profile.gender === 'male' ? 'Мужчина' : 'Женщина';
  const caption = `👤 *${escMd(profile.name)}*, ${profile.age} лет\n🚻 ${genderLabel}\n📝 ${escMd(profile.about)}`;
  if (profile.photo_id) {
    await bot.sendPhoto(chatId, profile.photo_id, {
      caption,
      parse_mode: 'Markdown',
      ...extra,
    });
  } else {
    await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', ...extra });
  }
}

function escMd(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ['👀 Смотреть анкеты', '❤️ Мои совпадения'],
        ['✏️ Редактировать анкету', '👤 Моя анкета'],
      ],
      resize_keyboard: true,
    },
  };
}

function cancelKeyboard() {
  return {
    reply_markup: {
      keyboard: [['❌ Отмена']],
      resize_keyboard: true,
    },
  };
}

function adminKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ['📊 Статистика', '📢 Рассылка'],
        ['➕ Добавить рекламу', '📋 Список реклам'],
        ['❌ Выйти из панели'],
      ],
      resize_keyboard: true,
    },
  };
}

// ─── registration flow ───────────────────────────────────────────────────────

async function startRegistration(chatId, userId) {
  userState[userId] = { step: 'reg_name' };
  await bot.sendMessage(chatId, '👋 Добро пожаловать в *ConnectKG* — знакомства в Бишкеке!\n\nДавай создадим твою анкету. Как тебя зовут?', {
    parse_mode: 'Markdown',
    ...cancelKeyboard(),
  });
}

async function handleRegistration(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = userState[userId];
  const text = msg.text || '';

  if (text === '❌ Отмена') {
    delete userState[userId];
    const user = await getUser(userId);
    if (user) {
      await bot.sendMessage(chatId, 'Отменено.', mainMenuKeyboard());
    } else {
      await bot.sendMessage(chatId, 'Отменено. Напиши /start чтобы начать заново.', { reply_markup: { remove_keyboard: true } });
    }
    return;
  }

  if (state.step === 'reg_name') {
    if (!text || text.length < 2) {
      await bot.sendMessage(chatId, 'Пожалуйста, введи своё настоящее имя (минимум 2 символа).');
      return;
    }
    state.name = text;
    state.step = 'reg_age';
    await bot.sendMessage(chatId, '📅 Сколько тебе лет?', cancelKeyboard());
  } else if (state.step === 'reg_age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 18 || age > 80) {
      await bot.sendMessage(chatId, 'Пожалуйста, введи возраст от 18 до 80.');
      return;
    }
    state.age = age;
    state.step = 'reg_gender';
    await bot.sendMessage(chatId, '🚻 Выбери свой пол:', {
      reply_markup: {
        keyboard: [['👨 Мужской', '👩 Женский'], ['❌ Отмена']],
        resize_keyboard: true,
      },
    });
  } else if (state.step === 'reg_gender') {
    if (text === '👨 Мужской') {
      state.gender = 'male';
    } else if (text === '👩 Женский') {
      state.gender = 'female';
    } else {
      await bot.sendMessage(chatId, 'Пожалуйста, выбери пол с помощью кнопок.');
      return;
    }
    state.step = 'reg_about';
    await bot.sendMessage(chatId, '📝 Расскажи немного о себе (интересы, чем занимаешься):', cancelKeyboard());
  } else if (state.step === 'reg_about') {
    if (!text || text.length < 10) {
      await bot.sendMessage(chatId, 'Напиши чуть больше о себе (минимум 10 символов).');
      return;
    }
    state.about = text;
    state.step = 'reg_photo';
    await bot.sendMessage(chatId, '📸 Отправь своё фото для анкеты:', cancelKeyboard());
  } else if (state.step === 'reg_photo') {
    if (!msg.photo) {
      await bot.sendMessage(chatId, 'Пожалуйста, отправь фото.');
      return;
    }
    const photo = msg.photo[msg.photo.length - 1];
    state.photo_id = photo.file_id;

    const { error } = await supabase.from('users').upsert({
      telegram_id: userId,
      name: state.name,
      age: state.age,
      gender: state.gender,
      about: state.about,
      photo_id: state.photo_id,
      active: true,
    }, { onConflict: 'telegram_id' });

    delete userState[userId];

    if (error) {
      await bot.sendMessage(chatId, 'Ошибка при сохранении анкеты. Попробуй ещё раз через /start.');
      return;
    }

    await bot.sendMessage(chatId, '✅ Анкета создана! Теперь можешь смотреть других пользователей.', mainMenuKeyboard());
  }
}

// ─── edit profile flow ───────────────────────────────────────────────────────

async function startEditProfile(chatId, userId) {
  userState[userId] = { step: 'edit_choose' };
  await bot.sendMessage(chatId, '✏️ Что хочешь изменить?', {
    reply_markup: {
      keyboard: [
        ['📛 Имя', '📅 Возраст'],
        ['📝 О себе', '📸 Фото'],
        ['❌ Отмена'],
      ],
      resize_keyboard: true,
    },
  });
}

async function handleEditProfile(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = userState[userId];
  const text = msg.text || '';

  if (text === '❌ Отмена') {
    delete userState[userId];
    await bot.sendMessage(chatId, 'Редактирование отменено.', mainMenuKeyboard());
    return;
  }

  if (state.step === 'edit_choose') {
    if (text === '📛 Имя') {
      state.step = 'edit_name';
      await bot.sendMessage(chatId, 'Введи новое имя:', cancelKeyboard());
    } else if (text === '📅 Возраст') {
      state.step = 'edit_age';
      await bot.sendMessage(chatId, 'Введи новый возраст:', cancelKeyboard());
    } else if (text === '📝 О себе') {
      state.step = 'edit_about';
      await bot.sendMessage(chatId, 'Напиши новое описание о себе:', cancelKeyboard());
    } else if (text === '📸 Фото') {
      state.step = 'edit_photo';
      await bot.sendMessage(chatId, 'Отправь новое фото:', cancelKeyboard());
    }
    return;
  }

  let updateData = null;

  if (state.step === 'edit_name') {
    if (!text || text.length < 2) {
      await bot.sendMessage(chatId, 'Имя должно быть не менее 2 символов.');
      return;
    }
    updateData = { name: text };
  } else if (state.step === 'edit_age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 18 || age > 80) {
      await bot.sendMessage(chatId, 'Возраст должен быть от 18 до 80.');
      return;
    }
    updateData = { age };
  } else if (state.step === 'edit_about') {
    if (!text || text.length < 10) {
      await bot.sendMessage(chatId, 'Описание должно быть не менее 10 символов.');
      return;
    }
    updateData = { about: text };
  } else if (state.step === 'edit_photo') {
    if (!msg.photo) {
      await bot.sendMessage(chatId, 'Пожалуйста, отправь фото.');
      return;
    }
    const photo = msg.photo[msg.photo.length - 1];
    updateData = { photo_id: photo.file_id };
  }

  if (updateData) {
    await supabase.from('users').update(updateData).eq('telegram_id', userId);
    delete userState[userId];
    await bot.sendMessage(chatId, '✅ Анкета обновлена!', mainMenuKeyboard());
  }
}

// ─── browse profiles ─────────────────────────────────────────────────────────

async function browseProfiles(chatId, userId) {
  const me = await getUser(userId);
  if (!me) return;

  const oppositeGender = me.gender === 'male' ? 'female' : 'male';

  const { data: likedRows } = await supabase
    .from('likes')
    .select('to_id')
    .eq('from_id', userId);

  const likedIds = (likedRows || []).map(r => r.to_id);
  likedIds.push(userId);

  const { data: profiles } = await supabase
    .from('users')
    .select('*')
    .eq('gender', oppositeGender)
    .eq('active', true)
    .not('telegram_id', 'in', `(${likedIds.join(',') || 0})`);

  if (!profiles || profiles.length === 0) {
    await bot.sendMessage(chatId, '😔 Пока нет новых анкет. Загляни позже!', mainMenuKeyboard());
    return;
  }

  const profile = profiles[Math.floor(Math.random() * profiles.length)];
  userState[userId] = { step: 'browsing', viewingId: profile.telegram_id };

  await sendProfile(chatId, profile, {
    reply_markup: {
      keyboard: [
        ['❤️ Лайк', '👎 Пропустить'],
        ['🏠 Главное меню'],
      ],
      resize_keyboard: true,
    },
  });
}

async function handleBrowse(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = userState[userId];
  const text = msg.text || '';

  if (text === '🏠 Главное меню') {
    delete userState[userId];
    await bot.sendMessage(chatId, 'Главное меню:', mainMenuKeyboard());
    return;
  }

  if (text === '❤️ Лайк') {
    const toId = state.viewingId;

    await supabase.from('likes').upsert({ from_id: userId, to_id: toId }, { onConflict: 'from_id,to_id' });

    const { data: mutual } = await supabase
      .from('likes')
      .select('id')
      .eq('from_id', toId)
      .eq('to_id', userId)
      .maybeSingle();

    if (mutual) {
      const u1 = Math.min(userId, toId);
      const u2 = Math.max(userId, toId);
      await supabase.from('matches').upsert({ user1_id: u1, user2_id: u2 }, { onConflict: 'user1_id,user2_id' });

      const me = await getUser(userId);
      const other = await getUser(toId);
      const ad = await getRandomAd();
      const adText = ad ? `\n\n📢 *Реклама:* ${escMd(ad.text)}` : '';

      const icebreaker = await generateIcebreaker(me.name, other.name);
      const icebreakerText = icebreaker ? `\n\n💬 _${escMd(icebreaker)}_` : '';

      const myUsername = msg.from.username ? `@${msg.from.username}` : 'без username';

      await bot.sendMessage(chatId,
        `🎉 *Взаимная симпатия!*\n\nВы с *${escMd(other.name)}* понравились друг другу!${icebreakerText}${adText}`,
        { parse_mode: 'Markdown' }
      );

      try {
        await bot.sendMessage(toId,
          `🎉 *Взаимная симпатия!*\n\nВы с *${escMd(me.name)}* понравились друг другу!\nКонтакт: ${escMd(myUsername)}${icebreakerText}${adText}`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) {}
    } else {
      await bot.sendMessage(chatId, '❤️ Лайк отправлен!');
    }

    await browseProfiles(chatId, userId);
    return;
  }

  if (text === '👎 Пропустить') {
    await browseProfiles(chatId, userId);
    return;
  }
}

// ─── show matches ─────────────────────────────────────────────────────────────

async function showMatches(chatId, userId) {
  const { data: matches } = await supabase
    .from('matches')
    .select('*')
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

  if (!matches || matches.length === 0) {
    await bot.sendMessage(chatId, '💔 У тебя пока нет совпадений.', mainMenuKeyboard());
    return;
  }

  await bot.sendMessage(chatId, `❤️ *Твои совпадения (${matches.length}):*`, { parse_mode: 'Markdown' });

  for (const match of matches) {
    const otherId = match.user1_id === userId ? match.user2_id : match.user1_id;
    const other = await getUser(otherId);
    if (other) {
      await sendProfile(chatId, other);
    }
  }

  await bot.sendMessage(chatId, 'Вот все твои совпадения!', mainMenuKeyboard());
}

// ─── admin panel ─────────────────────────────────────────────────────────────

async function handleAdmin(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '⛔ Нет доступа.');
    return;
  }

  userState[userId] = { step: 'admin_menu' };
  await bot.sendMessage(chatId, '🛠 *Панель администратора*', {
    parse_mode: 'Markdown',
    ...adminKeyboard(),
  });
}

async function handleAdminMenu(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = userState[userId];
  const text = msg.text || '';

  if (!isAdmin(userId)) return;

  if (text === '❌ Выйти из панели') {
    delete userState[userId];
    await bot.sendMessage(chatId, 'Вышел из панели администратора.', mainMenuKeyboard());
    return;
  }

  if (state.step === 'admin_menu') {
    if (text === '📊 Статистика') {
      const { count: usersCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
      const { count: likesCount } = await supabase.from('likes').select('*', { count: 'exact', head: true });
      const { count: matchesCount } = await supabase.from('matches').select('*', { count: 'exact', head: true });
      const { count: adsCount } = await supabase.from('ads').select('*', { count: 'exact', head: true }).eq('active', true);

      await bot.sendMessage(chatId,
        `📊 *Статистика ConnectKG:*\n\n👤 Пользователей: ${usersCount}\n❤️ Лайков: ${likesCount}\n🎉 Совпадений: ${matchesCount}\n📢 Активных реклам: ${adsCount}`,
        { parse_mode: 'Markdown' }
      );
    } else if (text === '📢 Рассылка') {
      state.step = 'admin_broadcast';
      await bot.sendMessage(chatId, 'Введи текст для рассылки всем пользователям:', cancelKeyboard());
    } else if (text === '➕ Добавить рекламу') {
      state.step = 'admin_add_ad';
      await bot.sendMessage(chatId, 'Введи текст рекламного объявления:', cancelKeyboard());
    } else if (text === '📋 Список реклам') {
      const { data: ads } = await supabase.from('ads').select('*').order('created_at', { ascending: false });
      if (!ads || ads.length === 0) {
        await bot.sendMessage(chatId, 'Нет рекламных объявлений.');
      } else {
        let listText = '📋 *Рекламные объявления:*\n\n';
        ads.forEach((ad, i) => {
          listText += `${i + 1}\\. \\[${ad.active ? '✅' : '❌'}\\] ${escMd(ad.text)}\n`;
        });
        await bot.sendMessage(chatId, listText, { parse_mode: 'MarkdownV2' });
      }
    }
    return;
  }

  if (state.step === 'admin_broadcast') {
    if (text === '❌ Отмена') {
      state.step = 'admin_menu';
      await bot.sendMessage(chatId, 'Отменено.', adminKeyboard());
      return;
    }

    const { data: users } = await supabase.from('users').select('telegram_id').eq('active', true);
    let sent = 0;
    let failed = 0;
    await bot.sendMessage(chatId, `⏳ Отправляю рассылку ${(users || []).length} пользователям...`);

    for (const u of users || []) {
      try {
        await bot.sendMessage(u.telegram_id, `📢 *Объявление:*\n\n${text}`, { parse_mode: 'Markdown' });
        sent++;
      } catch (_) {
        failed++;
      }
    }

    state.step = 'admin_menu';
    await bot.sendMessage(chatId, `✅ Рассылка завершена!\nОтправлено: ${sent}\nОшибок: ${failed}`, adminKeyboard());
    return;
  }

  if (state.step === 'admin_add_ad') {
    if (text === '❌ Отмена') {
      state.step = 'admin_menu';
      await bot.sendMessage(chatId, 'Отменено.', adminKeyboard());
      return;
    }

    await supabase.from('ads').insert({ text, active: true });
    state.step = 'admin_menu';
    await bot.sendMessage(chatId, '✅ Реклама добавлена!', adminKeyboard());
    return;
  }
}

// ─── Groq AI icebreaker ───────────────────────────────────────────────────────

async function generateIcebreaker(name1, name2) {
  try {
    const chat = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [
        {
          role: 'user',
          content: `Придумай короткое (1-2 предложения) смешное и дружелюбное приветствие для двух людей, которые только что совпали на сайте знакомств. Их зовут ${name1} и ${name2}. Напиши только текст сообщения, без кавычек.`,
        },
      ],
      max_tokens: 100,
    });
    return chat.choices[0]?.message?.content?.trim() || null;
  } catch (_) {
    return null;
  }
}

// ─── main message handler ────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || '';

  if (text === '/start') {
    const user = await getUser(userId);
    if (user) {
      await bot.sendMessage(chatId, `👋 С возвращением, *${escMd(user.name)}*!`, {
        parse_mode: 'Markdown',
        ...mainMenuKeyboard(),
      });
    } else {
      await startRegistration(chatId, userId);
    }
    return;
  }

  if (text === '/admin') {
    await handleAdmin(msg);
    return;
  }

  const state = userState[userId];

  if (state && (state.step === 'admin_menu' || state.step === 'admin_broadcast' || state.step === 'admin_add_ad')) {
    await handleAdminMenu(msg);
    return;
  }

  if (state && state.step && state.step.startsWith('reg_')) {
    await handleRegistration(msg);
    return;
  }

  if (state && state.step && state.step.startsWith('edit_')) {
    await handleEditProfile(msg);
    return;
  }

  if (state && state.step === 'browsing') {
    await handleBrowse(msg);
    return;
  }

  const user = await getUser(userId);
  if (!user) {
    await startRegistration(chatId, userId);
    return;
  }

  if (text === '👀 Смотреть анкеты') {
    await browseProfiles(chatId, userId);
    return;
  }

  if (text === '❤️ Мои совпадения') {
    await showMatches(chatId, userId);
    return;
  }

  if (text === '✏️ Редактировать анкету') {
    await startEditProfile(chatId, userId);
    return;
  }

  if (text === '👤 Моя анкета') {
    await sendProfile(chatId, user, mainMenuKeyboard());
    return;
  }

  await bot.sendMessage(chatId, 'Используй кнопки меню ниже 👇', mainMenuKeyboard());
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('ConnectKG bot started...');
