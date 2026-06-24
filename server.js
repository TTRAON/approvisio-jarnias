require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'jarnias-approvisio-change-me';

// Code admin par défaut (1er compte). Fourni dans le guide.
const BOOTSTRAP_ADMIN_CODE = process.env.ADMIN_CODE || 'JARNIAS-ADMIN-2026';

// ── DATABASE ──────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username      VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name          VARCHAR(100) NOT NULL,
      role          VARCHAR(20) NOT NULL DEFAULT 'conducteur',
      created_at    TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code        VARCHAR(40) PRIMARY KEY,
      role        VARCHAR(20) NOT NULL,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      used_by     UUID REFERENCES users(id) ON DELETE SET NULL,
      used_at     TIMESTAMP,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appros (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      data        JSONB NOT NULL,
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Base de données prête.');
}

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(header.split(' ')[1], SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès administrateur requis' });
  next();
}

function makeCode(role) {
  const prefix = role === 'admin' ? 'ADM' : role === 'depot' ? 'DEP' : 'CON';
  const rnd = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${rnd}`;
}

// ── AUTH ──────────────────────────────────────────────────────

// Inscription avec code d'invitation
app.post('/api/auth/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { username, password, name, code } = req.body;
    if (!username || !password || !name || !code) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min.)' });
    }

    let role = null;

    // Cas spécial : code admin bootstrap (uniquement si aucun admin n'existe encore)
    if (code === BOOTSTRAP_ADMIN_CODE) {
      const { rows } = await client.query("SELECT COUNT(*) FROM users WHERE role='admin'");
      if (parseInt(rows[0].count) === 0) {
        role = 'admin';
      } else {
        return res.status(400).json({ error: 'Le code admin par défaut a déjà été utilisé' });
      }
    } else {
      // Code d'invitation classique (à usage unique)
      const { rows } = await client.query('SELECT * FROM invite_codes WHERE code = $1', [code]);
      const invite = rows[0];
      if (!invite) return res.status(400).json({ error: 'Code d\'invitation invalide' });
      if (invite.used_by) return res.status(400).json({ error: 'Ce code a déjà été utilisé' });
      role = invite.role;
    }

    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    let newUser;
    try {
      const ins = await client.query(
        'INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id, username, name, role',
        [username, hash, name, role]
      );
      newUser = ins.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return res.status(400).json({ error: 'Cet identifiant est déjà pris' });
      throw e;
    }

    // Marquer le code comme utilisé (sauf bootstrap admin)
    if (code !== BOOTSTRAP_ADMIN_CODE) {
      await client.query(
        'UPDATE invite_codes SET used_by = $1, used_at = NOW() WHERE code = $2',
        [newUser.id, code]
      );
    }
    await client.query('COMMIT');

    const payload = { id: newUser.id, username: newUser.username, role: newUser.role, name: newUser.name };
    const token = jwt.sign(payload, SECRET, { expiresIn: '7d' });
    res.json({ token, user: payload });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// Connexion
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Identifiants requis' });
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Identifiants incorrects' });
    }
    const payload = { id: user.id, username: user.username, role: user.role, name: user.name };
    const token = jwt.sign(payload, SECRET, { expiresIn: '7d' });
    res.json({ token, user: payload });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Rafraîchir le token
app.post('/api/auth/refresh', auth, (req, res) => {
  const token = jwt.sign(
    { id: req.user.id, username: req.user.username, role: req.user.role, name: req.user.name },
    SECRET, { expiresIn: '7d' }
  );
  res.json({ token, user: { id: req.user.id, username: req.user.username, role: req.user.role, name: req.user.name } });
});

// ── INVITE CODES (admin) ──────────────────────────────────────
app.get('/api/invites', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ic.code, ic.role, ic.used_at, ic.created_at,
             u.name AS used_by_name
      FROM invite_codes ic
      LEFT JOIN users u ON ic.used_by = u.id
      ORDER BY ic.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.post('/api/invites', auth, adminOnly, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'conducteur', 'depot'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide' });
    }
    let code, ok = false, tries = 0;
    while (!ok && tries < 5) {
      code = makeCode(role);
      try {
        await pool.query('INSERT INTO invite_codes (code, role, created_by) VALUES ($1,$2,$3)', [code, role, req.user.id]);
        ok = true;
      } catch (e) { tries++; }
    }
    if (!ok) return res.status(500).json({ error: 'Impossible de générer le code' });
    res.json({ code, role });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/invites/:code', auth, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM invite_codes WHERE code = $1 AND used_by IS NULL', [req.params.code]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── USERS (admin) ─────────────────────────────────────────────
app.get('/api/users', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, username, name, role, created_at FROM users ORDER BY created_at');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.put('/api/users/:id/password', auth, adminOnly, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court' });
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

app.delete('/api/users/:id', auth, adminOnly, async (req, res) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Impossible de vous supprimer vous-même' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur' }); }
});

// ── APPROS (partagées, tous rôles connectés) ──────────────────
app.get('/api/appros', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, data, created_by, created_at, updated_at FROM appros ORDER BY updated_at DESC');
    res.json(rows.map(r => ({ ...r.data, _id: r.id, _createdBy: r.created_by, _updatedAt: r.updated_at })));
  } catch (e) { res.status(500).json({ error: 'Erreur lecture' }); }
});

app.post('/api/appros', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'INSERT INTO appros (data, created_by) VALUES ($1,$2) RETURNING id, created_at',
      [req.body, req.user.id]
    );
    res.json({ ...req.body, _id: rows[0].id });
  } catch (e) { res.status(500).json({ error: 'Erreur création' }); }
});

app.put('/api/appros/:id', auth, async (req, res) => {
  try {
    await pool.query('UPDATE appros SET data = $1, updated_at = NOW() WHERE id = $2', [req.body, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur mise à jour' }); }
});

app.delete('/api/appros/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM appros WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur suppression' }); }
});

// ── FRONTEND ──────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`AppROVISIO démarré sur le port ${PORT}`);
    console.log(`Code admin de démarrage : ${BOOTSTRAP_ADMIN_CODE}`);
  });
}).catch(err => {
  console.error('Erreur démarrage:', err.message);
  process.exit(1);
});
