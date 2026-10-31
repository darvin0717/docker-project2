const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SESSION_DAYS = 30;
const loginLimiter = auth.createLimiter(8, 15 * 60 * 1000);

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Личные данные не кэшируем
app.use(['/api/me', '/api/orders'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ---------- Вспомогательное для входа ----------
function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`);
}

async function startSession(res, userId) {
  const token = auth.newToken();
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3::int))`,
    [auth.hashToken(token), userId, SESSION_DAYS]
  );
  setSessionCookie(res, token, SESSION_DAYS * 24 * 3600);
}

async function currentUser(req) {
  const token = auth.parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [auth.hashToken(token)]
  );
  return rows[0] || null;
}

function requireJson(req, res, next) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Ожидается JSON' });
  next();
}

const fail = (res, err) => {
  console.error(err);
  res.status(500).json({ error: 'Ошибка сервера' });
};

// ---------- Проверка, что приложение и база живы ----------
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  } catch (err) {
    console.error('Health check: база недоступна', err.message);
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

// ---------- Каталог ----------
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, brand, category, description, long_description,
              price, emoji, stock, specs, image_url,
              banner_order, banner_title, banner_text, banner_color
         FROM products
        ORDER BY id`
    );
    res.json(rows);
  } catch (err) {
    fail(res, err);
  }
});

// ---------- Регистрация, вход, выход ----------
app.post('/api/register', requireJson, async (req, res) => {
  try {
    const problem = auth.validateRegistration(req.body || {});
    if (problem) return res.status(400).json({ error: problem });
    const { name, phone, password } = req.body;
    const email = auth.normalizeEmail(req.body.email);
    const hash = await auth.hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, name, email, phone`,
      [email, hash, String(name).trim(), String(phone || '').trim() || null]
    );
    if (!rows[0]) return res.status(409).json({ error: 'Этот e-mail уже зарегистрирован' });
    await startSession(res, rows[0].id);
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/login', requireJson, async (req, res) => {
  try {
    const email = auth.normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const key = req.ip + '|' + email;
    if (loginLimiter.blocked(key)) {
      return res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 15 минут' });
    }
    const { rows } = await pool.query(
      'SELECT id, name, email, phone, password_hash FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    const ok = user ? await auth.verifyPassword(password, user.password_hash) : false;
    if (!ok) {
      loginLimiter.fail(key);
      return res.status(401).json({ error: 'Неверный e-mail или пароль' });
    }
    loginLimiter.clear(key);
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    await startSession(res, user.id);
    delete user.password_hash;
    res.json({ user });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    const token = auth.parseCookies(req.headers.cookie).sid;
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [auth.hashToken(token)]);
    setSessionCookie(res, '', 0);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/me', async (req, res) => {
  try {
    res.json({ user: await currentUser(req) });
  } catch (err) {
    fail(res, err);
  }
});

// ---------- Мои заказы ----------
app.get('/api/orders', async (req, res) => {
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: 'Нужно войти' });
    const { rows } = await pool.query(
      `SELECT o.id, o.status, o.delivery_method, o.address, o.phone, o.total, o.created_at,
              COALESCE(
                json_agg(json_build_object('product_id', oi.product_id, 'name', p.name,
                                           'quantity', oi.quantity, 'price', oi.price) ORDER BY oi.id)
                FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
         FROM orders o
         LEFT JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE o.user_id = $1
        GROUP BY o.id
        ORDER BY o.id DESC`,
      [user.id]
    );
    res.json(rows);
  } catch (err) {
    fail(res, err);
  }
});

// Ошибки разбора запроса (например, битый JSON) отдаём как JSON
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Некорректный запрос' });
});

app.listen(PORT, () => {
  console.log(`Магазин запущен на порту ${PORT}`);
});
