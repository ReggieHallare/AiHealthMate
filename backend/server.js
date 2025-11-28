const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors()); // Allow Angular to talk to this server
app.use(bodyParser.json());

// Auth utilities (needed by some earlier handlers)
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// --- Database Connection (use pool + promises) ---
const dbHost = process.env.DB_HOST || 'localhost';
const dbUser = process.env.DB_USER || 'root';
const dbPass = process.env.DB_PASS || '';
const dbName = process.env.DB_NAME || 'ai_healthmate_db';

const pool = mysql.createPool({
    host: dbHost,
    user: dbUser,
    password: dbPass,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const db = pool.promise();

// Test DB connection on startup
db.query('SELECT 1')
  .then(() => console.log('Connected to MySQL Database'))
  .catch(err => console.error('Database connection failed:', err));

// Ensure history table exists
const createHistoryTable = `
CREATE TABLE IF NOT EXISTS analysis_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT DEFAULT NULL,
    user_name VARCHAR(255) DEFAULT NULL,
    symptoms TEXT,
    matched_condition_id INT DEFAULT NULL,
    matched_condition_name VARCHAR(255) DEFAULT NULL,
    accuracy INT DEFAULT NULL,
    meta JSON DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;
db.query(createHistoryTable).then(() => console.log('Ensured analysis_history table exists')).catch(err => console.warn('Could not ensure history table:', err));

// Health endpoint
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

// --- API Endpoint: List all known symptoms (unique) ---
app.get('/api/symptoms', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().toLowerCase();

        // If no query provided, return empty list to avoid sending huge lists
        if (!q) {
            return res.json({ success: true, symptoms: [] });
        }

        // Fetch candidate rows where symptoms string contains the query substring
        const sql = "SELECT symptoms FROM conditions WHERE symptoms IS NOT NULL AND symptoms <> '' AND LOWER(symptoms) LIKE ? LIMIT 200";
        const likePattern = `%${q}%`;
        const [rows] = await db.query(sql, [likePattern]);

        const set = new Set();
        rows.forEach(r => {
            String(r.symptoms || '').split('|').map(s => s.trim()).filter(Boolean).forEach(s => {
                if (s.toLowerCase().includes(q)) set.add(s);
            });
        });

        const list = Array.from(set).sort((a, b) => a.localeCompare(b));
        res.json({ success: true, symptoms: list });
    } catch (err) {
        console.error('Symptoms list error:', err);
        res.status(500).json({ error: err.message || err });
    }
});

// --- API Endpoint: Analyze Symptoms ---
app.post('/api/analyze', async (req, res) => {
    try {
        const raw = req.body.symptoms || '';
        const userSymptoms = String(raw).toLowerCase();

                // optional user info for history saving
                const userId = req.body.userId || null;
                const userName = req.body.name || null;
                const meta = {
                    age: req.body.age || null,
                    sex: req.body.sex || null,
                    selectedSymptoms: req.body.selectedSymptoms || null
                };

        // Fetch all conditions from DB
        const query = 'SELECT * FROM conditions';
        const [rows] = await db.query(query);

        let bestMatch = null;
        let highestScore = 0;

        // Matching Logic (Server-Side)
        rows.forEach(condition => {
            const dbSymptoms = String(condition.symptoms || '').split('|').map(s => s.trim()).filter(Boolean);
            let score = 0;

            dbSymptoms.forEach(symptom => {
                if (userSymptoms.includes(symptom.toLowerCase())) {
                    score++;
                }
            });

            if (score > highestScore) {
                highestScore = score;
                bestMatch = condition;
            }
        });

        // Compute result and accuracy
        let responsePayload = { success: false, match: null, accuracy: 0, historyId: null };
        if (bestMatch && highestScore > 0) {
            const totalKeywords = String(bestMatch.symptoms || '').split('|').filter(Boolean).length || 1;
            const accuracy = Math.min(Math.round((highestScore / totalKeywords) * 100), 95);
            responsePayload.success = true;
            responsePayload.match = bestMatch;
            responsePayload.accuracy = accuracy;
        } else {
            // no match found
            responsePayload.success = false;
            responsePayload.match = null;
            responsePayload.accuracy = 0;
        }

        // Always attempt to save history (best-effort). Use numeric userId when possible.
        try {
            const uid = userId !== null && userId !== undefined && userId !== '' ? Number(userId) : null;
            const insertSql = `INSERT INTO analysis_history (user_id, user_name, symptoms, matched_condition_id, matched_condition_name, accuracy, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`;
            const mId = responsePayload.match ? (responsePayload.match.id || null) : null;
            const mName = responsePayload.match ? (responsePayload.match.name || null) : null;
            const accuracyToSave = responsePayload.success ? responsePayload.accuracy : 0;
            const [r] = await db.query(insertSql, [uid, userName, raw, mId, mName, accuracyToSave, JSON.stringify(meta)]);
            const historyId = r && r.insertId ? r.insertId : null;
            responsePayload.historyId = historyId;
            console.log('Saved analysis_history id=', historyId, 'user_id=', uid);
        } catch (saveErr) {
            console.warn('Could not save history (analyze):', saveErr);
        }

        // Return payload
        return res.json(responsePayload);
    } catch (err) {
        console.error('Analyze error:', err);
        res.status(500).json({ error: err.message || err });
    }
});

// --- API: Get user's analysis history ---
app.get('/api/history', async (req, res) => {
    try {
        let userId = req.query.userId || req.body.userId || null;

        // If no userId provided, try to derive from Bearer token
        if (!userId) {
            const authHeader = req.headers.authorization || req.headers.Authorization || null;
            if (authHeader && String(authHeader).startsWith('Bearer ')) {
                const token = String(authHeader).slice(7).trim();
                try {
                    const payload = jwt.verify(token, JWT_SECRET);
                    if (payload && payload.uid) userId = payload.uid;
                } catch (e) {
                    console.warn('Could not verify JWT for history request:', e && e.message ? e.message : e);
                }
            }
        }

        const baseCols = 'id, user_id, user_name, symptoms, matched_condition_id, matched_condition_name, accuracy, meta, created_at';
        let rowsResult;
        if (userId) {
            const sql = `SELECT ${baseCols} FROM analysis_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`;
            [rowsResult] = await db.query(sql, [userId]);
        } else {
            const sql = `SELECT ${baseCols} FROM analysis_history WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 200`;
            [rowsResult] = await db.query(sql);
        }

        return res.json({ success: true, history: rowsResult || [] });
    } catch (err) {
        console.error('History fetch error:', err);
        res.status(500).json({ success: false, error: err.message || err });
    }
});

// Delete a history entry (requires userId to match)
app.delete('/api/history/:id', async (req, res) => {
    try {
        const id = req.params.id;
        let userId = req.query.userId || req.body.userId || null;
        // If no userId provided, attempt to derive from Authorization Bearer token
        if (!userId) {
            const authHeader = req.headers.authorization || req.headers.Authorization || null;
            if (authHeader && String(authHeader).startsWith('Bearer ')) {
                const token = String(authHeader).slice(7).trim();
                try {
                    const payload = jwt.verify(token, JWT_SECRET);
                    if (payload && payload.uid) userId = payload.uid;
                } catch (e) {
                    console.warn('Could not verify JWT for delete request:', e && e.message ? e.message : e);
                }
            }
        }
        if (!id) return res.status(400).json({ success: false, message: 'id is required' });

        // Verify ownership and then hard-delete the record
        const [rows] = await db.query('SELECT id, user_id FROM analysis_history WHERE id = ? LIMIT 1', [id]);
        if (!rows || rows.length === 0) {
            console.warn('Delete failed: not found id=', id);
            return res.status(404).json({ success: false, message: 'Not found' });
        }
        const row = rows[0];

        // If the row has an owner, require match with requester when possible
        if (row.user_id !== null && row.user_id !== undefined) {
            if (!userId) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
            if (String(row.user_id) !== String(userId)) {
                console.warn('Delete forbidden: owner mismatch', { id, owner: row.user_id, requester: userId });
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        }

        // Perform hard delete
        const [del] = await db.query('DELETE FROM analysis_history WHERE id = ? LIMIT 1', [id]);
        console.log('Deleted history id=', id, del);
        res.json({ success: true, id, deleted: true });
    } catch (err) {
        console.error('History delete error:', err);
        res.status(500).json({ success: false, error: err.message || err });
    }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
});

// --- Simple Auth Endpoints (register/login) ---

// Register a new user
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

        // Check existing
        const [exists] = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
        if (exists && exists.length) return res.status(409).json({ success: false, message: 'Email already registered' });

        const hash = await bcrypt.hash(String(password), 10);
        const insertSql = 'INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, NOW())';
        const [result] = await db.query(insertSql, [name || null, email, hash]);

        const userId = result && result.insertId ? result.insertId : null;
        const token = jwt.sign({ uid: userId, email }, JWT_SECRET, { expiresIn: '7d' });

        res.json({ success: true, user: { id: userId, name: name || null, email }, token });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ success: false, error: err.message || err });
    }
});

// Login existing user
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

        const [rows] = await db.query('SELECT id, name, email, password_hash FROM users WHERE email = ? LIMIT 1', [email]);
        if (!rows || rows.length === 0) return res.status(401).json({ success: false, message: 'Invalid credentials' });

        const user = rows[0];
        const ok = await bcrypt.compare(String(password), String(user.password_hash || ''));
        if (!ok) return res.status(401).json({ success: false, message: 'Invalid credentials' });

        const token = jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email }, token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, error: err.message || err });
    }
});

// NOTE: archive-by-index removed — archive concept removed from the project.

// ADMIN: Clear or reset analysis_history (protected by ADMIN_KEY env var)
// Use with caution. Provide header 'x-admin-key' with the ADMIN_KEY value.
app.post('/api/admin/clear-history', async (req, res) => {
    try {
        const adminKey = req.header('x-admin-key') || req.query.adminKey || req.body.adminKey || null;
        if (!process.env.ADMIN_KEY) return res.status(400).json({ success: false, message: 'Server ADMIN_KEY not configured' });
        if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ success: false, message: 'Forbidden' });

        // Delete all history and reset auto_increment
        await db.query('DELETE FROM analysis_history');
        try { await db.query('ALTER TABLE analysis_history AUTO_INCREMENT = 1'); } catch (e) { /* ignore if not supported */ }
        return res.json({ success: true, message: 'analysis_history cleared' });
    } catch (err) {
        console.error('Admin clear-history error:', err);
        res.status(500).json({ success: false, error: err.message || err });
    }
});

// Unarchive endpoint removed — archival feature no longer supported