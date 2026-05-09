require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');

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
// SUPABASE REST (без SDK)
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

async function getNext(userId) {
  const me = await getUser(userId);
  if (!me) return null;
  const gender = me.gender === 'мужской' ? 'женский' : 'мужской';
  const liked = await db('likes', 'GET', null, '?from_id=eq.' + userId + '&select=to_id');
  const ids = liked ? liked.map(l => l.to_id) : [];
  ids.push(userId);
  const d = await db('users', 'GET', null,
    '?gender=eq.' + encodeURIComponent(gender) +
    '&is_active=eq.true' +
    '&telegram_id=not.in.(' + ids.join(',') + ')' +
    '&limit=1'
  );
  return d && d[0] ? d[0] : null;
}

async function countTable(table) {
  const d = await db(table, 'GET', null, '?select=telegram_id');
  return d ? d.length : 0;
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
// ОТПРАВКА АНКЕТЫ
// ========================
async function sendProfile(chatId, p, kb) {
  const t = '👤 *' + esc(p.name) + ', ' + p.age + ' лет*\n' +
    (p.gender === 'мужской' ? '👨' : '👩') + ' ' + esc(p.city || 'Бишкек') +
    '\n\n📝 ' + esc(p.about || 'Не указано');
  if (p.photo_id) {
    await bot.sendPhoto(chatId, p.photo_id, { caption: t, parse_mode: 'Markdown', ...kb });
  } else {
    await bot.sendMessage(chatId, t, { parse_mode: 'Markdown', ...kb });
  }
}

async function showNext(userId) {
  const p = await getNext(userId);
  if (!p) return bot.sendMessage(userId, '😔 Анкеты закончились! Загляни позже 🌟', mainMenu);
  set(userId, 'viewing', { profileId: p.telegram_id });
  await sendProfile(userId, p, profileKb);
}

async function getCompliment(n1, n2) {
  if (!groq) return '🎉 У вас совпадение!';
  try {
    const c = await groq.chat.completions.create({
      messages: [{ role: 'user', content: 'Напиши короткое (1-2 предложения) поздравление с совпадением для ' + n1 + ' и ' + n2 + '. На русском.' }],
      model: 'llama3-8b-8192', max_tokens: 100
    });
    return c.choices[0]?.message?.content || '🎉 Совпадение!';
  } catch { return '🎉 У вас совпадение!'; }
}

// ========================
// /start
// ========================
bot.onText(/\/start/, async (msg) => {
  const id = msg.from.id;
  clear(id);
  const u = await getUser(id);
  if (u) {
    await bot.sendMessage(id, '👋 С возвращением, *' + esc(u.name) + '*!', { parse_mode: 'Markdown', ...mainMenu });
  } else {
    await bot.sendMessage(id, '👋 Добро пожаловать в ConnectKG — знакомства в Бишкеке! 🇰🇬\n\nДавай создадим анкету!');
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
  await bot.sendMessage(id, '🛠 *Панель администратора*', { parse_mode: 'Markdown', ...adminKb });
});

// ========================
// CALLBACK QUERY
// ========================
bot.on('callback_query', async (q) => {
  const id = q.from.id;
  const d = q.data;
  await bot.answerCallbackQuery(q.id);

  if (d.startsWith('gender_')) {
    const gender = d.replace('gender_', '');
    const { data: sd } = get(id);
    set(id, 'reg_about', { ...sd, gender });
    return bot.sendMessage(id, '💬 Расскажи о себе (интересы, что ищешь):');
  }

  if (d === 'like') {
    const { data: sd } = get(id);
    const tid = sd.profileId;
    if (!tid) return showNext(id);
    if (!await hasLiked(id, tid)) {
      await addLike(id, tid);
      if (await isMutual(id, tid)) {
        await addMatch(id, tid);
        const [me, them] = await Promise.all([getUser(id), getUser(tid)]);
        const c = await getCompliment(me.name, them.name);
        const ad = await getAd();
        const adT = ad ? '\n\n🎁 *' + esc(ad.business_name) + '*\n' + esc(ad.description) : '';
        await bot.sendMessage(id, '💘 *СОВПАДЕНИЕ!*\n\n' + esc(c) + '\n\n📩 Пиши: @' + (them.username || 'скрыт') + adT, { parse_mode: 'Markdown' });
        try { await bot.sendMessage(tid, '💘 *СОВПАДЕНИЕ!*\n\n' + esc(c) + '\n\n📩 Пиши: @' + (me.username || 'скрыт'), { parse_mode: 'Markdown' }); } catch (e) {}
      } else {
        await bot.sendMessage(id, '❤️ Лайк отправлен!');
      }
    }
    return showNext(id);
  }

  if (d === 'skip') return showNext(id);

  if (d === 'menu') {
    clear(id);
    return bot.sendMessage(id, '🏠 Главное меню', mainMenu);
  }

  if (d === 'edit_name') { set(id, 'edit_name'); return bot.sendMessage(id, '✏️ Новое имя:'); }
  if (d === 'edit_age') { set(id, 'edit_age'); return bot.sendMessage(id, '✏️ Новый возраст:'); }
  if (d === 'edit_about') { set(id, 'edit_about'); return bot.sendMessage(id, '✏️ Новое описание:'); }
  if (d === 'edit_photo') { set(id, 'edit_photo'); return bot.sendMessage(id, '📸 Новое фото:'); }

  if (d === 'toggle_active') {
    const u = await getUser(id);
    await updateUser(id, { is_active: !u.is_active });
    return bot.sendMessage(id, u.is_active ? '⏸ Анкета скрыта.' : '▶️ Анкета активна!', mainMenu);
  }

  if (d === 'admin_stats' && ADMIN_IDS.includes(id)) {
    const users = await countTable('users');
    const likes = await db('likes', 'GET', null, '?select=id');
    const matches = await db('matches', 'GET', null, '?select=id');
    return bot.sendMessage(id,
      '📊 *Статистика*\n\n👥 Пользователей: *' + users + '*\n❤️ Лайков: *' + (likes ? likes.length : 0) + '*\n💘 Совпадений: *' + (matches ? matches.length : 0) + '*',
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
    return bot.sendMessage(id, '📋 *Рекламы:*\n' + ads.map((a, i) => (i + 1) + '. *' + esc(a.business_name) + '*').join('\n'), { parse_mode: 'Markdown' });
  }
});

// ========================
// СООБЩЕНИЯ
// ========================
bot.on('message', async (msg) => {
  const id = msg.from.id;
  const text = msg.text;
  const { step, data } = get(id);

  // Главное меню
  if (text === '❤️ Смотреть анкеты') {
    const u = await getUser(id);
    if (!u) { set(id, 'reg_name'); return bot.sendMessage(id, '📝 Сначала создай анкету! Как тебя зовут?'); }
    return showNext(id);
  }

  if (text === '👤 Моя анкета') {
    const u = await getUser(id);
    if (!u) { set(id, 'reg_name'); return bot.sendMessage(id, '📝 Сначала создай анкету! Как тебя зовут?'); }
    const t = '👤 *Моя анкета*\n\n📝 Имя: *' + esc(u.name) + '*\n🎂 Возраст: *' + u.age + '*\n👫 Пол: *' + esc(u.gender) + '*\n💬 О себе: *' + esc(u.about || 'Не указано') + '*';
    const kb = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Имя', callback_data: 'edit_name' }, { text: '✏️ Возраст', callback_data: 'edit_age' }],
          [{ text: '✏️ Описание', callback_data: 'edit_about' }, { text: '📸 Фото', callback_data: 'edit_photo' }],
          [{ text: u.is_active ? '⏸ Скрыть анкету' : '▶️ Показать анкету', callback_data: 'toggle_active' }]
        ]
      }
    };
    if (u.photo_id) return bot.sendPhoto(id, u.photo_id, { caption: t, parse_mode: 'Markdown', ...kb });
    return bot.sendMessage(id, t, { parse_mode: 'Markdown', ...kb });
  }

  if (text === '⚙️ Настройки') {
    return bot.sendMessage(id, '⚙️ Настройки:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Редактировать анкету', callback_data: 'edit_about' }],
          [{ text: '📸 Сменить фото', callback_data: 'edit_photo' }]
        ]
      }
    });
  }

  if (text === '❓ Помощь') {
    return bot.sendMessage(id,
      'ConnectKG — знакомства в Бишкеке 🇰🇬\n\n1. Смотри анкеты\n2. Ставь лайки\n3. Совпадение = пишите друг другу! 💘\n\n/start — главное меню\n/admin — для администратора',
      mainMenu
    );
  }

  if (text && text.startsWith('/')) return;

  // Регистрация
  if (step === 'reg_name') {
    if (!text || text.length < 2 || text.length > 30) return bot.sendMessage(id, '⚠️ Имя от 2 до 30 символов:');
    set(id, 'reg_age', { name: text });
    return bot.sendMessage(id, '✅ ' + text + '!\n\n🎂 Сколько лет?');
  }

  if (step === 'reg_age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 16 || age > 80) return bot.sendMessage(id, '⚠️ Возраст от 16 до 80:');
    set(id, 'reg_gender', { ...data, age });
    return bot.sendMessage(id, '👫 Кто ты?', genderKb);
  }

  if (step === 'reg_about') {
    if (!text || text.length < 5 || text.length > 300) return bot.sendMessage(id, '⚠️ От 5 до 300 символов:');
    set(id, 'reg_photo', { ...data, about: text });
    return bot.sendMessage(id, '📸 Отправь фото или напиши "пропустить":');
  }

  if (step === 'reg_photo') {
    let photo = null;
    if (msg.photo) photo = msg.photo[msg.photo.length - 1].file_id;
    else if (text && text.toLowerCase() === 'пропустить') photo = null;
    else return bot.sendMessage(id, '📸 Фото или "пропустить":');
    try {
      await createUser({
        telegram_id: id,
        username: msg.from.username || null,
        name: data.name, age: data.age, gender: data.gender,
        about: data.about, photo_id: photo,
        city: 'Бишкек', is_active: true,
        created_at: new Date().toISOString()
      });
      clear(id);
      await bot.sendMessage(id, '🎉 Анкета создана! Добро пожаловать!', mainMenu);
      return showNext(id);
    } catch (e) {
      console.error('Ошибка создания:', e);
      return bot.sendMessage(id, '❌ Ошибка. Попробуй /start');
    }
  }

  // Редактирование
  if (step === 'edit_name') {
    if (!text || text.length < 2 || text.length > 30) return bot.sendMessage(id, '⚠️ От 2 до 30:');
    await updateUser(id, { name: text }); clear(id);
    return bot.sendMessage(id, '✅ Имя обновлено!', mainMenu);
  }

  if (step === 'edit_age') {
    const age = parseInt(text);
    if (isNaN(age) || age < 16 || age > 80) return bot.sendMessage(id, '⚠️ 16-80:');
    await updateUser(id, { age }); clear(id);
    return bot.sendMessage(id, '✅ Возраст обновлён!', mainMenu);
  }

  if (step === 'edit_about') {
    if (!text || text.length < 5 || text.length > 300) return bot.sendMessage(id, '⚠️ 5-300:');
    await updateUser(id, { about: text }); clear(id);
    return bot.sendMessage(id, '✅ Описание обновлено!', mainMenu);
  }

  if (step === 'edit_photo') {
    if (msg.photo) {
      await updateUser(id, { photo_id: msg.photo[msg.photo.length - 1].file_id });
      clear(id);
      return bot.sendMessage(id, '✅ Фото обновлено!', mainMenu);
    }
    return bot.sendMessage(id, '📸 Отправь фото:');
  }

  // Admin
  if (step === 'admin_broadcast' && ADMIN_IDS.includes(id)) {
    const users = await db('users', 'GET', null, '?is_active=eq.true&select=telegram_id');
    let s = 0, f = 0;
    for (const u of users || []) {
      try { await bot.sendMessage(u.telegram_id, '📢 ' + text); s++; }
      catch { f++; }
      await new Promise(r => setTimeout(r, 50));
    }
    clear(id);
    return bot.sendMessage(id, '✅ Отправлено: ' + s + ', Ошибок: ' + f, mainMenu);
  }

  if (step === 'admin_add_ad_name' && ADMIN_IDS.includes(id)) {
    set(id, 'admin_add_ad_desc', { ad_name: text });
    return bot.sendMessage(id, '📝 Описание/оффер:');
  }

  if (step === 'admin_add_ad_desc' && ADMIN_IDS.includes(id)) {
    set(id, 'admin_add_ad_contact', { ...data, ad_desc: text });
    return bot.sendMessage(id, '📞 Контакт (телефон или @username):');
  }

  if (step === 'admin_add_ad_contact' && ADMIN_IDS.includes(id)) {
    await db('ads', 'POST', { business_name: data.ad_name, description: data.ad_desc, contact: text, active: true, created_at: new Date().toISOString() });
    clear(id);
    return bot.sendMessage(id, '✅ Реклама добавлена!', mainMenu);
  }

  const u = await getUser(id);
  if (!u) { set(id, 'reg_name'); return bot.sendMessage(id, '📝 Как тебя зовут?'); }
  return bot.sendMessage(id, '🏠 Главное меню', mainMenu);
});

bot.on('polling_error', (e) => console.error('Polling error:', e.message));
process.on('unhandledRejection', (e) => console.error('Error:', e));
console.log('ConnectKG готов!');
