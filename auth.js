// Вспомогательные функции для регистрации и входа. Только встроенные модули Node.js.
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const N = 16384;
const KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [alg, n, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !n || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(n) });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const newToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* битое значение пропускаем */ }
  });
  return out;
}

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function validateRegistration({ name, email, phone, password }) {
  const n = String(name || '').trim();
  const e = normalizeEmail(email);
  const p = String(phone || '').trim();
  const pw = String(password || '');
  if (n.length < 2 || n.length > 60) return 'Имя должно быть от 2 до 60 символов';
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'Введите корректный e-mail';
  if (p && !/^\+?[0-9 ()-]{7,20}$/.test(p)) return 'Телефон: только цифры, пробелы, скобки, дефис и плюс';
  if (pw.length < 8) return 'Пароль должен быть не короче 8 символов';
  if (pw.length > 128) return 'Пароль слишком длинный';
  return null;
}

// Ограничение попыток входа: не больше max ошибок за окно времени для пары IP + e-mail
function createLimiter(max, windowMs) {
  const map = new Map();
  const entry = (key) => {
    const now = Date.now();
    let e = map.get(key);
    if (!e || e.resetAt < now) { e = { count: 0, resetAt: now + windowMs }; map.set(key, e); }
    return e;
  };
  return {
    blocked: (key) => entry(key).count >= max,
    fail: (key) => { entry(key).count += 1; },
    clear: (key) => { map.delete(key); }
  };
}

module.exports = { hashPassword, verifyPassword, newToken, hashToken, parseCookies, normalizeEmail, validateRegistration, createLimiter };
