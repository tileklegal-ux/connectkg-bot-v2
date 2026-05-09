require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

// ========================
// ИНИЦИАЛИЗАЦИЯ
// ========================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id)).filter(Boolean);

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SECRET) {
  console.error('❌ Не заданы обязательные переменные окружения: BOT_TOKEN, SUPABASE_URL, SUPABASE_SECRET');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

console.log('🚀 ConnectKG бот запущен!');

// ========================
// СОСТОЯНИЯ ПОЛЬЗОВАТЕЛЕЙ
// ========================
const userStates = {}; // { userId: { step, data } }

function setState(userId, step, data = {}) {
  userStates[userId] = { step, data };
}

function getState(userId) {
  return userStates[userId] || { step: null, data: {} };
}

function clearState(userId) {
  delete userStates[userId];
}

// ========================
// БАЗА ДАННЫХ — ПОЛЬЗОВАТЕЛИ
// ========================
async function getUser(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();
  return data;
}

async function createUser(userData) {
  const { data, error } = await supabase
    .from('users')
    .insert([userData])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateUser(telegramId, updates) {
  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('telegram_id', telegramId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ========================
// БАЗА ДАННЫХ — ЛАЙКИ И СОВПАДЕНИЯ
// ========================
async function addLike(fromId, toId) {
  await supabase.from('likes').insert([{ from_id: fromId, to_id: toId }]);
}

async function checkMutualLike(fromId, toId) {
  const { data } = await supabase
    .from('likes')
    .select('*')
    .eq('from_id', toId)
    .eq('to_id', fromId)
    .single();
  return !!data;
}

async function hasAlreadyLiked(fromId, toId) {
  const { data } = await supabase
    .from('likes')
    .select('*')
    .eq('from_id', fromId)
    .eq('to_id', toId)
    .single();
  return !!data;
}

async function addMatch(user1Id, user2Id) {
  await supabase.from('matches').insert([{ user1_id: user1Id, user2_id: user2Id }]);
}

// ========================
// БАЗА ДАННЫХ — РЕКЛАМА
// ========================
async function getRandomAd() {
  const { data } = await supabase
    .from('ads')
    .select('*')
    .eq('active', true);
  if (!data || data.length === 0) return null;
  return data[Math.floor(Math.random() * data.length)];
}

// ========================
// АНКЕТЫ ДЛЯ ПРОСМОТРА
// ========================
async function getNextProfile(userId) {
  const currentUser = await getUser(userId);
  if (!currentUser) return null;

  // Ищем анкеты противоположного пола, которых ещё не лайкали
  const gender = currentUser.gender === 'мужской' ? 'женский' : 'мужской';

  const { data: liked } = await supabase
    .from('likes')
    .select('to_id')
    .eq('from_id', userId);

  const likedIds = liked ? liked.map(l => l.to_id) : [];
  likedIds.push(userId); // исключаем себя

  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('gender', gender)
    .eq('is_active', true)
    .not('telegram_id', 'in', `(${likedIds.join(',')})`)
    .limit(1)
    .single();

  return data;
}

// ========================
// КЛАВИАТУРЫ
// ========================
const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [
      ['❤️ Смотреть анкеты', '👤 Моя анкета'],
      ['⚙️ Настройки', '❓ Помощь']
    ],
    resize_keyboard: true
  }
};

const registrationGenderKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '👨 Я мужчина', callback_data: 'gender_мужской' }],
      [{ text: '👩 Я женщина', callback_data: 'gender_женский' }]
    ]
  }
};

const profileViewKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '❤️ Лайк', callback_data: 'like' },
        { text: '👎 Пропустить', callback_data: 'skip' }
      ],
      [{ text: '🏠 Главное меню', callback_data: 'menu' }]
    ]
  }
};

const adminKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
      [{ text: '📢 Рассылка', callback_data: 'admin_broadcast' }],
      [{ text: '➕ Добавить рекламу', callback_data: 'admin_add_ad' }],
      [{ text: '📋 Список реклам', callback_data: 'admin_list_ads' }]
    ]
  }
};

// ========================
// ОТПРАВКА АНКЕТЫ
// ========================
async function sendProfile(chatId, profile, keyboard) {
  const text = `
👤 *${escapeMarkdown(profile.name)}, ${profile.age} лет*
${profile.gender === 'мужской' ? '👨' : '👩'} ${escapeMarkdown(profile.city || 'Бишкек')}

📝 ${escapeMarkdown(profile.about || 'Не указано')}
`;

  if (profile.photo_id) {
    await bot.sendPhoto(chatId, profile.photo_id, {
      caption: text,
      parse_mode: 'Markdown',
      ...keyboard
    });
  } else {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      ...keyboard
    });
  }
}

function escapeMarkdown(text) {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// ========================
// GROQ AI — КОМПЛИМЕНТ ПРИ СОВПАДЕНИИ
// ========================
async function getMatchCompliment(name1, name2) {
  if (!groq) return `🎉 У вас совпадение! Вы понравились друг другу!`;
  try {
    const completion = await groq.chat.completions.create({
      messages: [{
        role: 'user',
        content: `Напиши короткое (1-2 предложения) романтичное поздравление с совпадением для ${name1} и ${name2}. На русском языке. Без лишних слов.`
      }],
      model: 'llama3-8b-8192',
      max_tokens: 100
    });
    return completion.choices[0]?.message?.content || `🎉 У вас совпадение!`;
  } catch {
    return `🎉 У вас совпадение! Вы понравились друг другу!`;
  }
}

// ========================
// КОМАНДА /start
// ========================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const firstName = msg.from.first_name;

  const user = await getUser(userId);

  if (user) {
    await bot.sendMessage(userId,
      `👋 С возвращением, *${escapeMarkdown(user.name)}*!\n\nЧто хочешь сделать?`,
      { parse_mode: 'Markdown', ...mainMenuKeyboard }
    );
  } else {
    await bot.sendMessage(userId,
      `👋 Привет, *${escapeMarkdown(firstName)}*!\n\nДобро пожаловать в *ConnectKG* — знакомства в Бишкеке! 🇰🇬\n\nДавай создадим твою анкету. Это займёт меньше минуты!`,
      { parse_mode: 'Markdown' }
    );
    await startRegistration(userId);
  }
});

// ========================
// РЕГИСТРАЦИЯ
// ========================
async function startRegistration(userId) {
  setState(userId, 'reg_name');
  await bot.sendMessage(userId, '📝 *Как тебя зовут?*\n\nНапиши своё имя:', { parse_mode: 'Markdown' });
}

async function handleRegistration(msg) {
  const userId = msg.from.id;
  const { step, data } = getState(userId);
  const text = msg.text;

  if (step === 'reg_name') {
    if (!text || text.length < 2 || text.length > 30) {
      return bot.sendMessage(userId, '⚠️ Имя должно быть от 2 до 30 символов. Попробуй ещё раз:');
    }
    setState(userId, 'reg_age', { name: text });
    await bot.sendMessage(userId, `✅ Отлично, *${escapeMarkdown(text)}*!\n\n🎂 Сколько тебе лет?`, { parse_mode: 'Markdown' });

  } else if (step === 'reg_age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 16 || age > 80) {
      return bot.sendMessage(userId, '⚠️ Укажи реальный возраст (от 16 до 80):');
    }
    setState(userId, 'reg_gender', { ...data, age });
    await bot.sendMessage(userId, '👫 Кто ты?', registrationGenderKeyboard);

  } else if (step === 'reg_about') {
    if (!text || text.length < 5 || text.length > 300) {
      return bot.sendMessage(userId, '⚠️ Описание от 5 до 300 символов. Попробуй ещё раз:');
    }
    setState(userId, 'reg_photo', { ...data, about: text });
    await bot.sendMessage(userId,
      '📸 Отправь своё фото!\n\n_(или напиши "пропустить" если не хочешь)_',
      { parse_mode: 'Markdown' }
    );

  } else if (step === 'reg_photo') {
    let photoId = null;

    if (msg.photo) {
      photoId = msg.photo[msg.photo.length - 1].file_id;
    } else if (text && text.toLowerCase() === 'пропустить') {
      photoId = null;
    } else {
      return bot.sendMessage(userId, '📸 Отправь фото или напиши "пропустить":');
    }

    // Сохраняем пользователя
    try {
      const newUser = await createUser({
        telegram_id: userId,
        username: msg.from.username || null,
        name: data.name,
        age: data.age,
        gender: data.gender,
        about: data.about,
        photo_id: photoId,
        city: 'Бишкек',
        is_active: true,
        created_at: new Date().toISOString()
      });

      clearState(userId);

      await bot.sendMessage(userId,
        `🎉 *Анкета создана!*\n\n👤 ${escapeMarkdown(newUser.name)}, ${newUser.age} лет\n📍 Бишкек\n\nТеперь ты можешь смотреть анкеты и находить совпадения!`,
        { parse_mode: 'Markdown', ...mainMenuKeyboard }
      );
    } catch (err) {
      console.error('Ошибка создания пользователя:', err);
      await bot.sendMessage(userId, '❌ Произошла ошибка. Попробуй ещё раз /start');
    }
  }
}

// ========================
// ПРОСМОТР АНКЕТ
// ========================
async function showNextProfile(userId) {
  const profile = await getNextProfile(userId);

  if (!profile) {
    return bot.sendMessage(userId,
      '😔 *Анкеты закончились!*\n\nПока никого нет. Загляни позже — новые пользователи появляются каждый день! 🌟',
      { parse_mode: 'Markdown', ...mainMenuKeyboard }
    );
  }

  setState(userId, 'viewing', { currentProfileId: profile.telegram_id });
  await sendProfile(userId, profile, profileViewKeyboard);
}

// ========================
// ОБРАБОТКА ЛАЙКОВ
// ========================
async function handleLike(userId) {
  const { data } = getState(userId);
  const targetId = data.currentProfileId;

  if (!targetId) {
    return bot.sendMessage(userId, '⚠️ Что-то пошло не так. Попробуй снова.', mainMenuKeyboard);
  }

  // Проверяем дубликат
  const alreadyLiked = await hasAlreadyLiked(userId, targetId);
  if (alreadyLiked) {
    return showNextProfile(userId);
  }

  await addLike(userId, targetId);

  // Проверяем взаимный лайк
  const isMutual = await checkMutualLike(userId, targetId);

  if (isMutual) {
    await addMatch(userId, targetId);

    const [currentUser, targetUser] = await Promise.all([
      getUser(userId),
      getUser(targetId)
    ]);

    const compliment = await getMatchCompliment(currentUser.name, targetUser.name);
    const ad = await getRandomAd();

    const matchText = `
💘 *СОВПАДЕНИЕ!*

${compliment}

👤 *${escapeMarkdown(targetUser.name)}* понравилась тебе, и ты понравился ${escapeMarkdown(targetUser.name)}!

📩 Напиши им: @${targetUser.username || 'пользователь скрыл ник'}
`;

    await bot.sendMessage(userId, matchText, { parse_mode: 'Markdown' });

    // Уведомляем второго пользователя
    const matchTextForTarget = `
💘 *СОВПАДЕНИЕ!*

${compliment}

👤 *${escapeMarkdown(currentUser.name)}* тоже лайкнул тебя!

📩 Напиши им: @${currentUser.username || 'пользователь скрыл ник'}
`;
    try {
      await bot.sendMessage(targetId, matchTextForTarget, { parse_mode: 'Markdown' });
    } catch {}

    // Показываем рекламу при совпадении
    if (ad) {
      const adText = `\n\n🎁 *Специально для вас от наших партнёров:*\n\n📍 *${escapeMarkdown(ad.business_name)}*\n${escapeMarkdown(ad.description)}\n\n${ad.contact || ''}`;
      await bot.sendMessage(userId, adText, { parse_mode: 'Markdown' });
    }
  } else {
    await bot.sendMessage(userId, '❤️ Лайк отправлен!');
  }

  // Показываем следующую анкету
  await showNextProfile(userId);
}

// ========================
// МОЯ АНКЕТА
// ========================
async function showMyProfile(userId) {
  const user = await getUser(userId);
  if (!user) return bot.sendMessage(userId, '❌ Анкета не найдена. Напиши /start');

  const text = `
👤 *Моя анкета*

📝 Имя: *${escapeMarkdown(user.name)}*
🎂 Возраст: *${user.age} лет*
👫 Пол: *${escapeMarkdown(user.gender)}*
📍 Город: *${escapeMarkdown(user.city || 'Бишкек')}*
💬 О себе: *${escapeMarkdown(user.about || 'Не указано')}*
`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✏️ Изменить имя', callback_data: 'edit_name' }],
        [{ text: '✏️ Изменить возраст', callback_data: 'edit_age' }],
        [{ text: '✏️ Изменить описание', callback_data: 'edit_about' }],
        [{ text: '📸 Изменить фото', callback_data: 'edit_photo' }],
        [{ text: user.is_active ? '⏸ Скрыть анкету' : '▶️ Показать анкету', callback_data: 'toggle_active' }]
      ]
    }
  };

  if (user.photo_id) {
    await bot.sendPhoto(userId, user.photo_id, { caption: text, parse_mode: 'Markdown', ...keyboard });
  } else {
    await bot.sendMessage(userId, text, { parse_mode: 'Markdown', ...keyboard });
  }
}

// ========================
// КОМАНДА /admin
// ========================
bot.onText(/\/admin/, async (msg) => {
  const userId = msg.from.id;

  if (!ADMIN_IDS.includes(userId)) {
    return bot.sendMessage(userId, '❌ У вас нет доступа к панели администратора.');
  }

  await bot.sendMessage(userId, '🛠 *Панель администратора ConnectKG*', {
    parse_mode: 'Markdown',
    ...adminKeyboard
  });
});

// ========================
// ОБРАБОТЧИКИ CALLBACK
// ========================
bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  // --- РЕГИСТРАЦИЯ: ПОЛ ---
  if (data.startsWith('gender_')) {
    const gender = data.replace('gender_', '');
    const { data: stateData } = getState(userId);
    setState(userId, 'reg_about', { ...stateData, gender });
    await bot.sendMessage(userId, '💬 *Расскажи о себе* (интересы, чем занимаешься, что ищешь):', { parse_mode: 'Markdown' });
    return;
  }

  // --- ПРОСМОТР АНКЕТ ---
  if (data === 'like') {
    await handleLike(userId);
    return;
  }

  if (data === 'skip') {
    await showNextProfile(userId);
    return;
  }

  if (data === 'menu') {
    clearState(userId);
    await bot.sendMessage(userId, '🏠 Главное меню', mainMenuKeyboard);
    return;
  }

  // --- РЕДАКТИРОВАНИЕ АНКЕТЫ ---
  if (data === 'edit_name') {
    setState(userId, 'edit_name');
    await bot.sendMessage(userId, '✏️ Введи новое имя:');
    return;
  }

  if (data === 'edit_age') {
    setState(userId, 'edit_age');
    await bot.sendMessage(userId, '✏️ Введи новый возраст:');
    return;
  }

  if (data === 'edit_about') {
    setState(userId, 'edit_about');
    await bot.sendMessage(userId, '✏️ Напиши новое описание:');
    return;
  }

  if (data === 'edit_photo') {
    setState(userId, 'edit_photo');
    await bot.sendMessage(userId, '📸 Отправь новое фото:');
    return;
  }

  if (data === 'toggle_active') {
    const user = await getUser(userId);
    await updateUser(userId, { is_active: !user.is_active });
    await bot.sendMessage(userId,
      user.is_active ? '⏸ Анкета скрыта. Тебя не видят другие пользователи.' : '▶️ Анкета активна!',
      mainMenuKeyboard
    );
    return;
  }

  // --- ADMIN ---
  if (data === 'admin_stats' && ADMIN_IDS.includes(userId)) {
    const { count: usersCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: matchesCount } = await supabase.from('matches').select('*', { count: 'exact', head: true });
    const { count: likesCount } = await supabase.from('likes').select('*', { count: 'exact', head: true });

    await bot.sendMessage(userId,
      `📊 *Статистика ConnectKG*\n\n👥 Пользователей: *${usersCount || 0}*\n❤️ Лайков: *${likesCount || 0}*\n💘 Совпадений: *${matchesCount || 0}*`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (data === 'admin_broadcast' && ADMIN_IDS.includes(userId)) {
    setState(userId, 'admin_broadcast');
    await bot.sendMessage(userId, '📢 Введи текст рассылки (будет отправлен всем активным пользователям):');
    return;
  }

  if (data === 'admin_add_ad' && ADMIN_IDS.includes(userId)) {
    setState(userId, 'admin_add_ad_name');
    await bot.sendMessage(userId, '➕ *Добавление рекламы*\n\nВведи название бизнеса:', { parse_mode: 'Markdown' });
    return;
  }

  if (data === 'admin_list_ads' && ADMIN_IDS.includes(userId)) {
    const { data: ads } = await supabase.from('ads').select('*').eq('active', true);
    if (!ads || ads.length === 0) {
      await bot.sendMessage(userId, '📋 Активных реклам нет.');
    } else {
      const list = ads.map((ad, i) => `${i + 1}. *${escapeMarkdown(ad.business_name)}* — ${escapeMarkdown(ad.description)}`).join('\n');
      await bot.sendMessage(userId, `📋 *Активные рекламы:*\n\n${list}`, { parse_mode: 'Markdown' });
    }
    return;
  }
});

// ========================
// ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ
// ========================
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text = msg.text;
  const { step } = getState(userId);

  // Главное меню — кнопки
  if (text === '❤️ Смотреть анкеты') {
    const user = await getUser(userId);
    if (!user) return bot.sendMessage(userId, '❌ Сначала зарегистрируйся: /start');
    await showNextProfile(userId);
    return;
  }

  if (text === '👤 Моя анкета') {
    await showMyProfile(userId);
    return;
  }

  if (text === '⚙️ Настройки') {
    await bot.sendMessage(userId, '⚙️ *Настройки*\n\nЧто хочешь изменить?', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Редактировать анкету', callback_data: 'edit_about' }],
          [{ text: '📸 Сменить фото', callback_data: 'edit_photo' }]
        ]
      }
    });
    return;
  }

  if (text === '❓ Помощь') {
    await bot.sendMessage(userId,
      `❓ *Помощь*\n\n*ConnectKG* — это бот знакомств для Бишкека 🇰🇬\n\n*Как это работает:*\n1. Смотри анкеты\n2. Ставь ❤️ тем, кто понравился\n3. Если симпатия взаимна — это совпадение! 💘\n4. Напишите друг другу в Telegram\n\n*Команды:*\n/start — главное меню\n/admin — панель администратора\n\n📞 Поддержка: @connectkg`,
      { parse_mode: 'Markdown', ...mainMenuKeyboard }
    );
    return;
  }

  // Игнорируем команды
  if (text && text.startsWith('/')) return;

  // Обработка состояний регистрации
  if (step && step.startsWith('reg_')) {
    await handleRegistration(msg);
    return;
  }

  // Обработка редактирования анкеты
  if (step === 'edit_name') {
    if (!text || text.length < 2 || text.length > 30) {
      return bot.sendMessage(userId, '⚠️ Имя от 2 до 30 символов:');
    }
    await updateUser(userId, { name: text });
    clearState(userId);
    await bot.sendMessage(userId, `✅ Имя изменено на *${escapeMarkdown(text)}*`, { parse_mode: 'Markdown', ...mainMenuKeyboard });
    return;
  }

  if (step === 'edit_age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 16 || age > 80) {
      return bot.sendMessage(userId, '⚠️ Возраст от 16 до 80:');
    }
    await updateUser(userId, { age });
    clearState(userId);
    await bot.sendMessage(userId, `✅ Возраст изменён на *${age}*`, { parse_mode: 'Markdown', ...mainMenuKeyboard });
    return;
  }

  if (step === 'edit_about') {
    if (!text || text.length < 5 || text.length > 300) {
      return bot.sendMessage(userId, '⚠️ Описание от 5 до 300 символов:');
    }
    await updateUser(userId, { about: text });
    clearState(userId);
    await bot.sendMessage(userId, '✅ Описание обновлено!', mainMenuKeyboard);
    return;
  }

  if (step === 'edit_photo') {
    if (msg.photo) {
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      await updateUser(userId, { photo_id: photoId });
      clearState(userId);
      await bot.sendMessage(userId, '✅ Фото обновлено!', mainMenuKeyboard);
    } else {
      await bot.sendMessage(userId, '📸 Отправь фото:');
    }
    return;
  }

  // Admin: рассылка
  if (step === 'admin_broadcast' && ADMIN_IDS.includes(userId)) {
    const { data: users } = await supabase.from('users').select('telegram_id').eq('is_active', true);
    let sent = 0, failed = 0;
    for (const user of users || []) {
      try {
        await bot.sendMessage(user.telegram_id, `📢 *Сообщение от ConnectKG:*\n\n${text}`, { parse_mode: 'Markdown' });
        sent++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 50)); // задержка чтобы не превысить лимиты
    }
    clearState(userId);
    await bot.sendMessage(userId, `✅ Рассылка завершена!\n✉️ Отправлено: ${sent}\n❌ Не доставлено: ${failed}`, mainMenuKeyboard);
    return;
  }

  // Admin: добавление рекламы
  if (step === 'admin_add_ad_name' && ADMIN_IDS.includes(userId)) {
    setState(userId, 'admin_add_ad_desc', { ad_name: text });
    await bot.sendMessage(userId, '📝 Введи описание/оффер для рекламы (например: "Скидка 10% для пар"):');
    return;
  }

  if (step === 'admin_add_ad_desc' && ADMIN_IDS.includes(userId)) {
    const { data: stateData } = getState(userId);
    setState(userId, 'admin_add_ad_contact', { ...stateData, ad_desc: text });
    await bot.sendMessage(userId, '📞 Введи контакт бизнеса (телефон или @username):');
    return;
  }

  if (step === 'admin_add_ad_contact' && ADMIN_IDS.includes(userId)) {
    const { data: stateData } = getState(userId);
    await supabase.from('ads').insert([{
      business_name: stateData.ad_name,
      description: stateData.ad_desc,
      contact: text,
      active: true,
      created_at: new Date().toISOString()
    }]);
    clearState(userId);
    await bot.sendMessage(userId, `✅ Реклама *${escapeMarkdown(stateData.ad_name)}* добавлена!`, { parse_mode: 'Markdown', ...adminKeyboard });
    return;
  }

  // Если непонятное сообщение — показываем меню
  const user = await getUser(userId);
  if (!user) {
    await bot.sendMessage(userId, '👋 Напиши /start чтобы начать!');
  } else {
    await bot.sendMessage(userId, '🏠 Главное меню', mainMenuKeyboard);
  }
});

// ========================
// ОБРАБОТКА ОШИБОК
// ========================
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

console.log('✅ ConnectKG бот готов к работе!');
