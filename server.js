const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Проверка, что приложение и база живы
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  } catch (err) {
    console.error('Health check: база недоступна', err.message);
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

// Каталог товаров
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
    console.error(err);
    res.status(500).json({ error: 'Ошибка базы данных' });
  }
});

app.listen(PORT, () => {
  console.log(`Магазин запущен на порту ${PORT}`);
});
