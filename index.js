require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const express = require('express');
const app = express();

// ========================
// EXPRESS MIDDLEWARE
// ========================
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ========================
// HEALTH CHECK
// ========================
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get('/', (req, res) => res.send('ConnectKG API is running'));

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SECRET) {
  console.error('Не заданы: BOT_TOKEN, SUPABASE_URL, SUPABASE_SECRET');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
console.log('ConnectKG бот запущен!');

// ========================
// SUPABASE REST
// ========================
async function db(table, method, body, query) {
  method = method || 'GET';
  query = query || '';
  const url = SUPABASE_URL + '/rest/v1/' + table + query;
  const headers = {
    'apikey': SUPABASE_SECRET,
    'Authorization': 'Bearer ' + SUPABASE_SECRET,
    'Content-Type': 'application/json'
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getUser(id) {
  const d = await db('users', 'GET', null, '?telegram_id=eq.' + id);
  return d && d[0] ? d[0] : null;
}
async function createUser(u) {
  const d = await db('users', 'POST', u);
  return d && d[0] ? d[0] : u;
}
async function updateUser(id, u) {
  await db('users', 'PATCH', u, '?telegram_id=eq.' + id);
}
async function addLike(f, t) {
  try { await db('likes', 'POST', { from_id: f, to_id: t }); } catch(e) {}
}
async function hasLiked(f, t) {
  const d = await db('likes', 'GET', null, '?from_id=eq.' + f + '&to_id=eq.' + t);
  return d && d.length > 0;
}
async function isMutual(f, t) {
  const d = await db('likes', 'GET', null, '?from_id=eq.' + t + '&to_id=eq.' + f);
  return d && d.length > 0;
}
async function addMatch(a, b) {
  try { await db('matches', 'POST', { user1_id: a, user2_id: b }); } catch(e) {}
}
async function getAd() {
  const d = await db('ads', 'GET', null, '?active=eq.true');
  return d && d.length ? d[Math.floor(Math.random() * d.length)] : null;
}

function getDist(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

async function getNext(userId) {
  const me = await getUser(userId);
  if (!me) return null;
  const lookingFor = me.looking_for || (me.gender === 'мужской' ? 'женский' : 'мужской');
  const liked = await db('likes', 'GET', null, '?from_id=eq.' + userId + '&select=to_id');
  const ids = liked ? liked.map(l => l.to_id) : [];
  ids.push(userId);
  let query = '?is_active=eq.true&telegram_id=not.in.(' + ids.join(',') + ')';
  if (lookingFor !== 'все') query += '&gender=eq.' + encodeURIComponent(lookingFor);
  query += '&limit=20';
  const d = await db('users', 'GET', null, query);
  if (!d || !d.length) return null;
  if (me.latitude && me.longitude) {
    d.sort((a, b) => {
      const da = a.latitude ? getDist(me.latitude, me.longitude, a.latitude, a.longitude) : 9999;
      const db2 = b.latitude ? getDist(me.latitude, me.longitude, b.latitude, b.longitude) : 9999;
      return da - db2;
    });
  }
  return d[0];
}

// ========================
// СОСТОЯНИЯ
// ========================
const states = {};
function set(id, step, data) { states[id] = { step, data: data || {} }; }
function get(id) { return states[id] || { step: null, data: {} }; }
function clear(id) { delete states[id]; }
function esc(t) {
  if (!t) return '';
  return String(t).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// ========================
// КЛАВИАТУРЫ
// ========================
const mainMenu = {
  reply_markup: {
    keyboard: [
      ['❤️ Смотреть анкеты', '👤 Моя анкета'],
      ['⚙️ Настройки', '❓ Помощь']
    ],
    resize_keyboard: true
  }
};

const genderKb = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '👨 Я мужчина', callback_data: 'gender_мужской' }],
      [{ text: '👩 Я женщина', callback_data: 'gender_женский' }]
    ]
  }
};

const lookingForKb = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '👩 Ищу девушку', callback_data: 'lf_женский' }],
      [{ text: '👨 Ищу парня', callback_data: 'lf_мужской' }],
      [{ text: '👫 Ищу всех', callback_data: 'lf_все' }]
    ]
  }
};

const cityKb = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🏙 Бишкек', callback_data: 'city_Бишкек' }, { text: '🌆 Ош', callback_data: 'city_Ош' }],
      [{ text: '🏘 Джалал-Абад', callback_data: 'city_Джалал-Абад' }, { text: '🏔 Каракол', callback_data: 'city_Каракол' }],
      [{ text: '🌍 Другой город', callback_data: 'city_другой' }]
    ]
  }
};

const locationKb = {
  reply_markup: {
    keyboard: [
      [{ text: '📍 Отправить геолокацию', request_location: true }],
      [{ text: '⏭ Пропустить', }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  }
};

const profileKb = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '❤️ Лайк', callback_data: 'like' }, { text: '👎 Пропустить', callback_data: 'skip' }],
      [{ text: '🏠 Меню', callback_data: 'menu' }]
    ]
  }
};

const adminKb = {
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
// AI ФУНКЦИИ
// ========================
async function getAICompatibility(me, them) {
  if (!groq) return null;
  try {
    const c = await groq.chat.completions.create({
      messages: [{
        role: 'user',
        content: `Два человека познакомились. Проанализируй их и дай результат СТРОГО в таком формате:
ПРОЦЕНТ: [число от 60 до 99]
ОБЩЕЕ: [1 предложение что их объединяет]
ФРАЗА: [первая фраза для знакомства от имени ${me.name} к ${them.name}]

Человек 1: ${me.name}, ${me.age} лет, ${me.gender}. О себе: ${me.about || 'не указано'}
Человек 2: ${them.name}, ${them.age} лет, ${them.gender}. О себе: ${them.about || 'не указано'}

Отвечай только в указанном формате, на русском языке.`
      }],
      model: 'llama3-8b-8192',
      max_tokens: 150
    });
    return c.choices[0]?.message?.content || null;
  } catch { return null; }
}

function parseAI(text) {
  if (!text) return { percent: 75, common: 'У вас много общего!', phrase: 'Привет! Ты мне понравился(ась)!' };
  const percentMatch = text.match(/ПРОЦЕНТ:\s*(\d+)/);
  const commonMatch = text.match(/ОБЩЕЕ:\s*(.+)/);
  const phraseMatch = text.match(/ФРАЗА:\s*(.+)/);
  return {
    percent: percentMatch ? parseInt(percentMatch[1]) : 75,
    common: commonMatch ? commonMatch[1].trim() : 'У вас много общего!',
    phrase: phraseMatch ? phraseMatch[1].trim() : 'Привет!'
  };
}

// ========================
// ОТПРАВКА АНКЕТЫ
// ========================
async function sendProfile(chatId, p, kb, viewerLat, viewerLon) {
  let distText = '';
  if (viewerLat && viewerLon && p.latitude && p.longitude) {
    const dist = getDist(viewerLat, viewerLon, p.latitude, p.longitude);
    distText = '\n📍 ' + (dist < 1 ? 'Рядом с тобой' : 'В ' + dist + ' км от тебя');
  } else if (p.city) {
    distText = '\n📍 ' + p.city + ', Кыргызстан';
  }
  const t = '👤 *' + esc(p.name) + ', ' + p.age + ' лет*\n' +
    (p.gender === 'мужской' ? '👨 Мужчина' : '👩 Женщина') +
    distText + '\n\n💬 ' + esc(p.about || 'Не указано');
  if (p.photo_id) {
    await bot.sendPhoto(chatId, p.photo_id, { caption: t, parse_mode: 'Markdown', ...kb });
  } else {
    await bot.sendMessage(chatId, t, { parse_mode: 'Markdown', ...kb });
  }
}

async function showNext(userId) {
  const me = await getUser(userId);
  const p = await getNext(userId);
  if (!p) return bot.sendMessage(userId, '😔 Анкеты закончились! Загляни позже 🌟\n\nРасскажи друзьям о ConnectKG — пусть регистрируются! 🇰🇬', mainMenu);
  set(userId, 'viewing', { profileId: p.telegram_id });
  await sendProfile(userId, p, profileKb, me ? me.latitude : null, me ? me.longitude : null);
}

// ========================
// /start
// ========================
bot.onText(/\/start/, async (msg) => {
  const id = msg.from.id;
  clear(id);
  const u = await getUser(id);
  if (u) {
    await bot.sendMessage(id, '👋 С возвращением, *' + esc(u.name) + '*!\n\n🇰🇬 ConnectKG — знакомства по всему Кыргызстану', { parse_mode: 'Markdown', ...mainMenu });
  } else {
    await bot.sendMessage(id, '👋 Добро пожаловать в *ConnectKG*!\n\n🇰🇬 Знакомства по всему Кыргызстану\n💘 Найди своего человека прямо в Telegram\n\nДавай создадим твою анкету!', { parse_mode: 'Markdown' });
    set(id, 'reg_name');
    await bot.sendMessage(id, '📝 Как тебя зовут?');
  }
});

// ========================
// /admin
// ========================
bot.onText(/\/admin/, async (msg) => {
  const id = msg.from.id;
  if (!ADMIN_IDS.includes(id)) return bot.sendMessage(id, '❌ Нет доступа.');
  await bot.sendMessage(id, '🛠 *Панель администратора ConnectKG*', { parse_mode: 'Markdown', ...adminKb });
});

// ========================
// CALLBACK QUERY
// ========================
bot.on('callback_query', async (q) => {
  const id = q.from.id;
  const d = q.data;
  await bot.answerCallbackQuery(q.id);

  // Регистрация - пол
  if (d.startsWith('gender_')) {
    const gender = d.replace('gender_', '');
    const { data: sd } = get(id);
    set(id, 'reg_looking_for', { ...sd, gender });
    return bot.sendMessage(id, '🔍 Кого ты ищешь?', lookingForKb);
  }

  // Регистрация - кого ищет
  if (d.startsWith('lf_')) {
    const lf = d.replace('lf_', '');
    const { data: sd } = get(id);
    set(id, 'reg_city', { ...sd, looking_for: lf });
    return bot.sendMessage(id, '🏙 Из какого ты города?', cityKb);
  }

  // Регистрация - город
  if (d.startsWith('city_')) {
    const city = d.replace('city_', '');
    const { data: sd } = get(id);
    if (city === 'другой') {
      set(id, 'reg_city_text', { ...sd });
      return bot.sendMessage(id, '🏙 Напиши свой город:');
    }
    set(id, 'reg_about', { ...sd, city });
    return bot.sendMessage(id, '💬 Расскажи о себе (интересы, хобби, что ищешь):');
  }

  // Лайк
  if (d === 'like') {
    const { data: sd } = get(id);
    const tid = sd.profileId;
    if (!tid) return showNext(id);
    if (!await hasLiked(id, tid)) {
      await addLike(id, tid);
      if (await isMutual(id, tid)) {
        await addMatch(id, tid);
        const [me, them] = await Promise.all([getUser(id), getUser(tid)]);
        const aiText = await getAICompatibility(me, them);
        const ai = parseAI(aiText);
        const ad = await getAd();
        const adT = ad ? '\n\n🎁 *Специально для вас:*\n*' + esc(ad.business_name) + '*\n' + esc(ad.description) + '\n' + (ad.contact || '') : '';

        const matchMsg = '💘 *СОВПАДЕНИЕ!*\n\n' +
          '🎯 Совместимость: *' + ai.percent + '%*\n' +
          '✨ ' + esc(ai.common) + '\n\n' +
          '💬 Начни разговор: _' + esc(ai.phrase) + '_\n\n' +
          '📩 Написать: @' + (them.username || 'скрыт') + adT;

        const matchMsgThem = '💘 *СОВПАДЕНИЕ!*\n\n' +
          '🎯 Совместимость: *' + ai.percent + '%*\n' +
          '✨ ' + esc(ai.common) + '\n\n' +
          '📩 Написать: @' + (me.username || 'скрыт');

        await bot.sendMessage(id, matchMsg, { parse_mode: 'Markdown' });
        try { await bot.sendMessage(tid, matchMsgThem, { parse_mode: 'Markdown' }); } catch(e) {}
      } else {
        await bot.sendMessage(id, '❤️ Лайк отправлен!');
      }
    }
    return showNext(id);
  }

  if (d === 'skip') return showNext(id);
  if (d === 'menu') { clear(id); return bot.sendMessage(id, '🏠 Главное меню', mainMenu); }

  // Редактирование
  if (d === 'edit_name') { set(id, 'edit_name'); return bot.sendMessage(id, '✏️ Новое имя:'); }
  if (d === 'edit_age') { set(id, 'edit_age'); return bot.sendMessage(id, '✏️ Новый возраст:'); }
  if (d === 'edit_about') { set(id, 'edit_about'); return bot.sendMessage(id, '✏️ Новое описание:'); }
  if (d === 'edit_photo') { set(id, 'edit_photo'); return bot.sendMessage(id, '📸 Новое фото:'); }
  if (d === 'edit_city') { set(id, 'edit_city'); return bot.sendMessage(id, '🏙 Выбери город:', cityKb); }
  if (d.startsWith('city_edit_')) {
    const city = d.replace('city_edit_', '');
    await updateUser(id, { city });
    clear(id);
    return bot.sendMessage(id, '✅ Город обновлён: ' + city, mainMenu);
  }

  if (d === 'toggle_active') {
    const u = await getUser(id);
    await updateUser(id, { is_active: !u.is_active });
    return bot.sendMessage(id, u.is_active ? '⏸ Анкета скрыта.' : '▶️ Анкета активна!', mainMenu);
  }

  // Admin
  if (d === 'admin_stats' && ADMIN_IDS.includes(id)) {
    const users = await db('users', 'GET', null, '?select=telegram_id');
    const likes = await db('likes', 'GET', null, '?select=id');
    const matches = await db('matches', 'GET', null, '?select=id');
    const usersCount = users ? users.length : 0;
    const likesCount = likes ? likes.length : 0;
    const matchesCount = matches ? matches.length : 0;
    return bot.sendMessage(id,
      '📊 *Статистика ConnectKG*\n\n👥 Пользователей: *' + usersCount + '*\n❤️ Лайков: *' + likesCount + '*\n💘 Совпадений: *' + matchesCount + '*',
      { parse_mode: 'Markdown' }
    );
  }

  if (d === 'admin_broadcast' && ADMIN_IDS.includes(id)) {
    set(id, 'admin_broadcast');
    return bot.sendMessage(id, '📢 Введи текст рассылки:');
  }

  if (d === 'admin_add_ad' && ADMIN_IDS.includes(id)) {
    set(id, 'admin_add_ad_name');
    return bot.sendMessage(id, '➕ Название бизнеса:');
  }

  if (d === 'admin_list_ads' && ADMIN_IDS.includes(id)) {
    const ads = await db('ads', 'GET', null, '?active=eq.true');
    if (!ads || !ads.length) return bot.sendMessage(id, '📋 Реклам нет.');
    return bot.sendMessage(id,
      '📋 *Рекламы:*\n' + ads.map((a, i) => (i+1) + '. *' + esc(a.business_name) + '* — ' + esc(a.description)).join('\n'),
      { parse_mode: 'Markdown' }
    );
  }
});

// ========================
// СООБЩЕНИЯ
// ========================
bot.on('message', async (msg) => {
  const id = msg.from.id;
  const text = msg.text;
  const { step, data } = get(id);

  // Геолокация
  if (msg.location) {
    const { latitude, longitude } = msg.location;
    if (step === 'reg_location') {
      await updateUser(id, { latitude, longitude });
      clear(id);
      await bot.sendMessage(id, '📍 Геолокация сохранена!\n\n🎉 Анкета создана! Теперь ты будешь видеть людей рядом с тобой!', mainMenu);
      return showNext(id);
    }
    await updateUser(id, { latitude, longitude });
    return bot.sendMessage(id, '📍 Геолокация обновлена!', mainMenu);
  }

  // Главное меню
  if (text === '❤️ Смотреть анкеты') {
    const u = await getUser(id);
    if (!u) { set(id, 'reg_name'); return bot.sendMessage(id, '📝 Сначала создай анкету! Как тебя зовут?'); }
    return showNext(id);
  }

  if (text === '👤 Моя анкета') {
    const u = await getUser(id);
    if (!u) { set(id, 'reg_name'); return bot.sendMessage(id, '📝 Сначала создай анкету! Как тебя зовут?'); }
    const t = '👤 *Моя анкета*\n\n' +
      '📝 Имя: *' + esc(u.name) + '*\n' +
      '🎂 Возраст: *' + u.age + '*\n' +
      '👫 Пол: *' + esc(u.gender) + '*\n' +
      '🔍 Ищу: *' + esc(u.looking_for || 'не указано') + '*\n' +
      '📍 Город: *' + esc(u.city || 'Кыргызстан') + '*\n' +
      '💬 О себе: *' + esc(u.about || 'Не указано') + '*\n' +
      '📡 Геолокация: *' + (u.latitude ? '✅ есть' : '❌ нет') + '*';
    const kb = { reply_markup: { inline_keyboard: [
      [{ text: '✏️ Имя', callback_data: 'edit_name' }, { text: '✏️ Возраст', callback_data: 'edit_age' }],
      [{ text: '✏️ Описание', callback_data: 'edit_about' }, { text: '📸 Фото', callback_data: 'edit_photo' }],
      [{ text: '🏙 Город', callback_data: 'edit_city' }],
      [{ text: u.is_active ? '⏸ Скрыть анкету' : '▶️ Показать анкету', callback_data: 'toggle_active' }]
    ]}};
    if (u.photo_id) return bot.sendPhoto(id, u.photo_id, { caption: t, parse_mode: 'Markdown', ...kb });
    return bot.sendMessage(id, t, { parse_mode: 'Markdown', ...kb });
  }

  if (text === '⚙️ Настройки') {
    return bot.sendMessage(id, '⚙️ *Настройки*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '✏️ Редактировать анкету', callback_data: 'edit_about' }],
      [{ text: '📸 Сменить фото', callback_data: 'edit_photo' }],
      [{ text: '🏙 Изменить город', callback_data: 'edit_city' }]
    ]}});
  }

  if (text === '❓ Помощь') {
    return bot.sendMessage(id,
      '❓ *ConnectKG* — знакомства по всему Кыргызстану 🇰🇬\n\n' +
      '1. Смотри анкеты\n' +
      '2. Ставь ❤️ лайки\n' +
      '3. Взаимный лайк = совпадение 💘\n' +
      '4. ИИ покажет совместимость и подскажет первую фразу!\n\n' +
      '/start — главное меню\n\n' +
      '📞 Поддержка: @connectkg_support',
      { parse_mode: 'Markdown', ...mainMenu }
    );
  }

  if (text === '⏭ Пропустить' && step === 'reg_location') {
    clear(id);
    await bot.sendMessage(id, '🎉 Анкета создана! Добро пожаловать в ConnectKG!', mainMenu);
    return showNext(id);
  }

  if (text && text.startsWith('/')) return;

  // Регистрация
  if (step === 'reg_name') {
    if (!text || text.length < 2 || text.length > 30) return bot.sendMessage(id, '⚠️ Имя от 2 до 30 символов:');
    set(id, 'reg_age', { name: text });
    return bot.sendMessage(id, '✅ ' + text + '!\n\n🎂 Сколько тебе лет?');
  }

  if (step === 'reg_age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 16 || age > 80) return bot.sendMessage(id, '⚠️ Возраст от 16 до 80:');
    set(id, 'reg_gender', { ...data, age });
    return bot.sendMessage(id, '👫 Кто ты?', genderKb);
  }

  if (step === 'reg_city_text') {
    if (!text || text.length < 2) return bot.sendMessage(id, '⚠️ Напиши название города:');
    set(id, 'reg_about', { ...data, city: text });
    return bot.sendMessage(id, '💬 Расскажи о себе (интересы, хобби, что ищешь):');
  }

  if (step === 'reg_about') {
    if (!text || text.length < 5 || text.length > 300) return bot.sendMessage(id, '⚠️ От 5 до 300 символов:');
    set(id, 'reg_photo', { ...data, about: text });
    return bot.sendMessage(id, '📸 Отправь своё фото или напиши "пропустить":');
  }

  if (step === 'reg_photo') {
    let photo = null;
    if (msg.photo) photo = msg.photo[msg.photo.length - 1].file_id;
    else if (text && text.toLowerCase() === 'пропустить') photo = null;
    else return bot.sendMessage(id, '📸 Отправь фото или напиши "пропустить":');
    try {
      await createUser({
        telegram_id: id,
        username: msg.from.username || null,
        name: data.name, age: data.age, gender: data.gender,
        looking_for: data.looking_for || (data.gender === 'мужской' ? 'женский' : 'му
