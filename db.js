// طبقة قاعدة البيانات: PostgreSQL (عند وجود DATABASE_URL) أو SQLite المدمج في Node محلياً
const path = require('path');
const fs = require('fs');

let mode, sqlite, pool;

const SCHEMA = (serial, big) => `
  CREATE TABLE IF NOT EXISTS students (
    id ${serial},
    name TEXT NOT NULL,
    grade TEXT NOT NULL,
    ip TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    correct INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    created_at ${big} NOT NULL,
    last_answer_at ${big}
  );
  CREATE INDEX IF NOT EXISTS idx_students_ip ON students(ip);
  CREATE TABLE IF NOT EXISTS solved (
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    first_try INTEGER NOT NULL,
    created_at ${big} NOT NULL,
    PRIMARY KEY (student_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS attempts (
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (student_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS lesson_state (
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    lesson_id TEXT NOT NULL,
    mistakes INTEGER NOT NULL DEFAULT 0,
    needs_review INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (student_id, lesson_id)
  );
`;

async function init() {
  if (process.env.DATABASE_URL) {
    mode = 'pg';
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
    });
    await pool.query(SCHEMA('SERIAL PRIMARY KEY', 'BIGINT'));
  } else {
    mode = 'sqlite';
    const { DatabaseSync } = require('node:sqlite'); // مدمج في Node 22.13+
    const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
    fs.mkdirSync(dir, { recursive: true });
    sqlite = new DatabaseSync(path.join(dir, 'quiz.db'));
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    sqlite.exec(SCHEMA('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER'));
  }
  console.log(`[db] using ${mode === 'pg' ? 'PostgreSQL' : 'SQLite'}`);
}

// استعلام موحد: يكتب بصيغة $1, $2 ويحوَّل لـ ? في SQLite
async function query(sql, params = []) {
  if (mode === 'pg') {
    const r = await pool.query(sql, params);
    return { rows: r.rows, changes: r.rowCount };
  }
  const ordered = [];
  const stmt = sqlite.prepare(sql.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[n - 1]); return '?'; }));
  if (/^\s*SELECT|RETURNING/i.test(sql)) return { rows: stmt.all(...ordered), changes: 0 };
  const r = stmt.run(...ordered);
  return { rows: [], changes: Number(r.changes) };
}

function normStudent(s) {
  if (!s) return null;
  return {
    id: Number(s.id), name: s.name, grade: s.grade, ip: s.ip, token: s.token,
    correct: Number(s.correct), answered: Number(s.answered), points: Number(s.points),
    created_at: Number(s.created_at),
    last_answer_at: s.last_answer_at == null ? null : Number(s.last_answer_at),
  };
}

module.exports = {
  init,
  get mode() { return mode; },

  async studentByToken(token) {
    if (!token) return null;
    const { rows } = await query('SELECT * FROM students WHERE token = $1', [token]);
    return normStudent(rows[0]);
  },
  async countByIp(ip) {
    const { rows } = await query('SELECT COUNT(*) AS c FROM students WHERE ip = $1', [ip]);
    return Number(rows[0].c);
  },
  async studentByIpAndName(ip, name) {
    const { rows } = await query('SELECT * FROM students WHERE ip = $1 AND name = $2 ORDER BY id LIMIT 1', [ip, name]);
    return normStudent(rows[0]);
  },
  async createStudent({ name, grade, ip, token }) {
    const { rows } = await query(
      'INSERT INTO students (name, grade, ip, token, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, grade, ip, token, Date.now()]
    );
    return normStudent(rows[0]);
  },

  async solvedIds(studentId) {
    const { rows } = await query('SELECT question_id FROM solved WHERE student_id = $1', [studentId]);
    return new Set(rows.map(r => r.question_id));
  },
  async triesMap(studentId) {
    const { rows } = await query('SELECT question_id, tries FROM attempts WHERE student_id = $1', [studentId]);
    return new Map(rows.map(r => [r.question_id, Number(r.tries)]));
  },
  async lessonState(studentId, lessonId) {
    const { rows } = await query('SELECT mistakes, needs_review FROM lesson_state WHERE student_id = $1 AND lesson_id = $2', [studentId, lessonId]);
    return rows[0] ? { mistakes: Number(rows[0].mistakes), needsReview: Number(rows[0].needs_review) === 1 } : { mistakes: 0, needsReview: false };
  },
  async setLessonState(studentId, lessonId, mistakes, needsReview) {
    await query(
      `INSERT INTO lesson_state (student_id, lesson_id, mistakes, needs_review) VALUES ($1, $2, $3, $4)
       ON CONFLICT (student_id, lesson_id) DO UPDATE SET mistakes = $3, needs_review = $4`,
      [studentId, lessonId, mistakes, needsReview ? 1 : 0]
    );
  },

  // تسجيل محاولة. يرجع { firstTry, alreadySolved }
  async recordAttempt(studentId, questionId, isCorrect, points) {
    const now = Date.now();
    const { rows } = await query('SELECT tries FROM attempts WHERE student_id = $1 AND question_id = $2', [studentId, questionId]);
    const prevTries = rows[0] ? Number(rows[0].tries) : 0;
    await query(
      `INSERT INTO attempts (student_id, question_id, tries) VALUES ($1, $2, 1)
       ON CONFLICT (student_id, question_id) DO UPDATE SET tries = attempts.tries + 1`,
      [studentId, questionId]
    );
    const firstTry = prevTries === 0;
    if (isCorrect) {
      const r = await query(
        'INSERT INTO solved (student_id, question_id, first_try, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [studentId, questionId, firstTry ? 1 : 0, now]
      );
      if (!r.changes) return { alreadySolved: true };
    }
    const gain = isCorrect && firstTry;
    await query(
      'UPDATE students SET answered = answered + 1, correct = correct + $1, points = points + $2, last_answer_at = $3 WHERE id = $4',
      [gain ? 1 : 0, gain ? points : 0, now, studentId]
    );
    return { firstTry, alreadySolved: false };
  },

  async leaderboard(limit = 100, grade = null) {
    const where = grade ? 'WHERE grade = $2' : '';
    const params = grade ? [limit, grade] : [limit];
    const { rows } = await query(
      `SELECT * FROM students ${where} ORDER BY correct DESC, points DESC, last_answer_at ASC, id ASC LIMIT $1`, params);
    return rows.map(normStudent);
  },
  async rankOf(s) {
    const { rows } = await query(
      `SELECT COUNT(*) AS c FROM students WHERE correct > $1 OR (correct = $1 AND points > $2)
       OR (correct = $1 AND points = $2 AND COALESCE(last_answer_at, 0) < $3 AND id <> $4)`,
      [s.correct, s.points, s.last_answer_at || 0, s.id]);
    return Number(rows[0].c) + 1;
  },
  async allStudents() {
    const { rows } = await query('SELECT * FROM students ORDER BY correct DESC, points DESC, id ASC');
    return rows.map(normStudent);
  },
  async solvedCounts() {
    const { rows } = await query('SELECT student_id, COUNT(*) AS c FROM solved GROUP BY student_id');
    return new Map(rows.map(r => [Number(r.student_id), Number(r.c)]));
  },
  async resetProgress(id) {
    for (const t of ['solved', 'attempts', 'lesson_state']) await query(`DELETE FROM ${t} WHERE student_id = $1`, [id]);
    await query('UPDATE students SET correct = 0, answered = 0, points = 0, last_answer_at = NULL WHERE id = $1', [id]);
  },
  async deleteStudent(id) {
    for (const t of ['solved', 'attempts', 'lesson_state']) await query(`DELETE FROM ${t} WHERE student_id = $1`, [id]);
    const r = await query('DELETE FROM students WHERE id = $1', [id]);
    return r.changes > 0;
  },
};
