// منصة تحدي الرياضيات — الخادم (بدون مكتبات خارجية: Node.js 22.13+ فقط)
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

// ===== الإعدادات (تُضبط من متغيرات البيئة عند النشر) =====
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';      // غيّرها عند النشر!
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP || '1', 10);       // عدد الحسابات المسموح بها لكل IP
const TRUST_PROXY = parseInt(process.env.TRUST_PROXY ?? '1', 10) || 0; // عدد البروكسيات أمام الخادم (Render/Railway = 1، تشغيل محلي = 0)
const POINTS = { 1: 10, 2: 20, 3: 30 };
const MAX_MISTAKES = 3; // بعد 3 أخطاء في الدرس يعود الطالب للشرح
const LEVEL_NAMES = { 1: 'سهل', 2: 'متوسط', 3: 'صعب' };
const GRADES = [
  'الأول الابتدائي', 'الثاني الابتدائي', 'الثالث الابتدائي', 'الرابع الابتدائي', 'الخامس الابتدائي', 'السادس الابتدائي',
  'الأول المتوسط', 'الثاني المتوسط', 'الثالث المتوسط',
  'الأول الثانوي', 'الثاني الثانوي', 'الثالث الثانوي',
];
if (ADMIN_PASSWORD === 'admin123') console.warn('⚠️  ADMIN_PASSWORD غير مضبوطة — غيّرها قبل النشر');

// ===== تحميل المنهج (الفصول ← الدروس ← الأسئلة) =====
let CHAPTERS, LESSONS, LMAP, QMAP, TOTAL_Q;
function loadCurriculum() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'curriculum.json'), 'utf8'));
  const lessons = [], lmap = new Map(), qmap = new Map();
  raw.chapters.forEach(ch => ch.lessons.forEach(l => {
    if (lmap.has(l.id)) throw new Error('درس مكرر: ' + l.id);
    l.questions.forEach((q, i) => {
      if (!q.id || ![1, 2, 3].includes(q.level) || !q.text || !Array.isArray(q.choices) || q.choices.length < 2 ||
          !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) {
        throw new Error(`سؤال غير صالح في الدرس ${l.id} رقم ${i + 1}`);
      }
      if (qmap.has(q.id)) throw new Error('سؤال مكرر: ' + q.id);
      q._order = i;
      qmap.set(q.id, { ...q, lessonId: l.id });
    });
    l.questions.sort((a, b) => a.level - b.level || a._order - b._order);
    const entry = { ...l, chapterId: ch.id, index: lessons.length };
    lessons.push(entry); lmap.set(l.id, entry);
  }));
  CHAPTERS = raw.chapters; LESSONS = lessons; LMAP = lmap; QMAP = qmap; TOTAL_Q = qmap.size;
}
loadCurriculum();

// حالة كل درس للطالب: مقفل / مفتوح / منتهٍ — الدروس تُفتح بالترتيب
function lessonStatuses(solved) {
  const out = new Map();
  let prevDone = true;
  for (const l of LESSONS) {
    const n = l.questions.filter(q => solved.has(q.id)).length;
    const done = n === l.questions.length;
    out.set(l.id, { solved: n, total: l.questions.length, status: done ? 'done' : prevDone ? 'open' : 'locked' });
    prevDone = done;
  }
  return out;
}

// ===== أدوات مساعدة =====
function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY > 0 && req.headers['x-forwarded-for']) {
    const list = String(req.headers['x-forwarded-for']).split(',').map(s => s.trim()).filter(Boolean);
    // نأخذ العنوان الذي أضافه البروكسي الموثوق (لا يمكن للمستخدم تزويره)
    ip = list[Math.max(0, list.length - TRUST_PROXY)] || ip;
  }
  return ip.replace(/^::ffff:/, '');
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function tokenCookie(req, token) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `mq_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}${secure}`;
}
function cleanName(s) {
  return String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}
function publicStudent(s) {
  return { id: s.id, name: s.name, grade: s.grade, correct: s.correct, answered: s.answered, points: s.points };
}
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' };
function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 20000) { reject(new HttpError(413, 'الطلب كبير')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, 'بيانات غير صالحة')); } });
    req.on('error', reject);
  });
}

// حد بسيط لعدد الطلبات لكل IP (حماية من الإغراق)
const hits = new Map();
function rateLimit(req, key, max, windowMs) {
  const k = key + '|' + req.ip, now = Date.now();
  const h = hits.get(k) || { n: 0, t: now };
  if (now - h.t > windowMs) { h.n = 0; h.t = now; }
  h.n++; hits.set(k, h);
  if (h.n > max) throw new HttpError(429, 'طلبات كثيرة، حاول بعد قليل');
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 600000) hits.delete(k); }, 600000).unref();

async function requireStudent(req) {
  const s = await db.studentByToken(getCookie(req, 'mq_token'));
  if (!s) throw new HttpError(401, 'غير مسجل');
  return s;
}
function requireAdmin(req) {
  const pw = req.headers['x-admin-password'] || req.query.get('pw') || '';
  const a = Buffer.from(String(pw)), b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'كلمة المرور غير صحيحة');
}

// ===== المسارات =====
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/config', async () => ({ grades: GRADES }));

route('GET', '/api/me', async (req) => {
  const s = await db.studentByToken(getCookie(req, 'mq_token'));
  if (s) return { student: publicStudent(s), rank: await db.rankOf(s) };
  return { student: null, blocked: (await db.countByIp(req.ip)) >= MAX_PER_IP };
});

route('POST', '/api/register', async (req, res) => {
  rateLimit(req, 'register', 10, 60000);
  const body = await readBody(req);
  const name = cleanName(body.name), grade = String(body.grade || '');
  if (name.length < 3 || name.length > 50) throw new HttpError(400, 'اكتب اسمك (3 أحرف على الأقل)');
  if (!GRADES.includes(grade)) throw new HttpError(400, 'اختر الصف');
  const existing = await db.studentByToken(getCookie(req, 'mq_token'));
  if (existing) throw new HttpError(409, 'أنت مسجل مسبقاً');
  if ((await db.countByIp(req.ip)) >= MAX_PER_IP) throw new HttpError(403, 'هذا الجهاز مسجّل مسبقاً', { blocked: true });
  const token = crypto.randomBytes(24).toString('hex');
  const s = await db.createStudent({ name, grade, ip: req.ip, token });
  res.setHeader('Set-Cookie', tokenCookie(req, token));
  return { student: publicStudent(s) };
});

// استعادة الحساب لنفس الطالب إذا مُسحت الكوكيز (نفس الـ IP ونفس الاسم)
route('POST', '/api/restore', async (req, res) => {
  rateLimit(req, 'restore', 10, 60000);
  const body = await readBody(req);
  const s = await db.studentByIpAndName(req.ip, cleanName(body.name));
  if (!s) throw new HttpError(404, 'الاسم غير موجود');
  res.setHeader('Set-Cookie', tokenCookie(req, s.token));
  return { student: publicStudent(s) };
});

// خريطة الفصول والدروس مع حالة كل درس
route('GET', '/api/map', async (req) => {
  const st = await requireStudent(req);
  const statuses = lessonStatuses(await db.solvedIds(st.id));
  return {
    chapters: CHAPTERS.map(ch => {
      const lessons = ch.lessons.map(l => ({ id: l.id, num: l.num, title: l.title, ...statuses.get(l.id) }));
      return {
        id: ch.id, num: ch.num, title: ch.title, color: ch.color, icon: ch.icon,
        lessons,
        done: lessons.filter(l => l.status === 'done').length,
        status: lessons.every(l => l.status === 'locked') ? 'locked' : lessons.every(l => l.status === 'done') ? 'done' : 'open',
      };
    }),
  };
});

async function openLesson(st, lessonId) {
  const l = LMAP.get(lessonId);
  if (!l) throw new HttpError(404, 'الدرس غير موجود');
  const solved = await db.solvedIds(st.id);
  const status = lessonStatuses(solved).get(l.id);
  if (status.status === 'locked') throw new HttpError(403, 'الدرس مقفل');
  return { l, solved, status };
}

// الدرس: الشرح + الحالة
route('GET', '/api/lesson/:id', async (req, res, p) => {
  const st = await requireStudent(req);
  const { l, status } = await openLesson(st, p.id);
  const tries = await db.triesMap(st.id);
  const state = await db.lessonState(st.id, l.id);
  const started = l.questions.some(q => tries.has(q.id));
  const next = LESSONS[l.index + 1];
  return {
    lesson: { id: l.id, num: l.num, title: l.title, chapterId: l.chapterId, explain: l.explain },
    ...status, started, needsReview: state.needsReview, mistakes: state.mistakes, maxMistakes: MAX_MISTAKES,
    nextLessonId: next ? next.id : null,
  };
});

// تم الانتهاء من مراجعة الشرح ← العودة للأسئلة
route('POST', '/api/lesson/:id/reviewed', async (req, res, p) => {
  const st = await requireStudent(req);
  const { l } = await openLesson(st, p.id);
  await db.setLessonState(st.id, l.id, 0, false);
  return { ok: true };
});

// السؤال التالي في الدرس (الأسئلة التي لم تُحل، والأسئلة الخاطئة تعود في آخر الدرس)
route('GET', '/api/lesson/:id/question', async (req, res, p) => {
  const st = await requireStudent(req);
  const { l, solved, status } = await openLesson(st, p.id);
  const state = await db.lessonState(st.id, l.id);
  if (state.needsReview) return { review: true };
  const tries = await db.triesMap(st.id);
  const pending = l.questions.filter(q => !solved.has(q.id))
    .map((q, i) => ({ q, i, t: tries.get(q.id) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const next = LESSONS[l.index + 1];
  if (!pending.length) return { done: true, nextLessonId: next ? next.id : null };
  const q = pending[0].q;
  return {
    question: { id: q.id, level: q.level, levelName: LEVEL_NAMES[q.level], text: q.text, choices: q.choices, retry: (tries.get(q.id) || 0) > 0 },
    solved: status.solved, total: status.total,
    mistakes: state.mistakes, maxMistakes: MAX_MISTAKES,
  };
});

route('POST', '/api/answer', async (req) => {
  const st = await requireStudent(req);
  rateLimit(req, 'answer', 60, 60000);
  const body = await readBody(req);
  const q = QMAP.get(String(body.questionId));
  const choice = Number(body.choice);
  if (!q) throw new HttpError(400, 'سؤال غير موجود');
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.choices.length) throw new HttpError(400, 'اختيار غير صالح');
  const { l, solved } = await openLesson(st, q.lessonId);
  if (solved.has(q.id)) throw new HttpError(409, 'تم حل هذا السؤال');
  const state = await db.lessonState(st.id, l.id);
  if (state.needsReview) throw new HttpError(409, 'راجع الشرح أولاً', { review: true });

  const isCorrect = choice === q.answer;
  const r = await db.recordAttempt(st.id, q.id, isCorrect, POINTS[q.level]);
  if (r.alreadySolved) throw new HttpError(409, 'تم حل هذا السؤال');

  let mistakes = state.mistakes, review = false;
  if (!isCorrect) {
    mistakes++;
    if (mistakes >= MAX_MISTAKES) { review = true; mistakes = 0; }
    await db.setLessonState(st.id, l.id, mistakes, review);
  }
  const s = await db.studentByToken(st.token);
  const solvedNow = isCorrect ? solved.size + 1 : solved.size;
  const lessonSolved = l.questions.filter(x => solved.has(x.id) || (isCorrect && x.id === q.id)).length;
  return {
    correct: isCorrect,
    // لا نكشف الإجابة الصحيحة عند الخطأ، لأن السؤال سيعود لاحقاً
    answer: isCorrect ? q.answer : undefined,
    explanation: isCorrect ? (q.explanation || '') : '',
    hint: isCorrect ? '' : (q.hint || ''),
    mistakes: review ? MAX_MISTAKES : mistakes, maxMistakes: MAX_MISTAKES, review,
    lessonSolved, lessonTotal: l.questions.length, lessonDone: lessonSolved === l.questions.length,
    totalSolved: solvedNow,
    student: publicStudent(s),
  };
});

route('GET', '/api/leaderboard', async (req) => {
  const g = req.query.get('grade');
  const rows = await db.leaderboard(100, GRADES.includes(g) ? g : null);
  return { rows: rows.map((s, i) => ({ rank: i + 1, ...publicStudent(s) })) };
});

// ===== لوحة المعلم =====
route('GET', '/api/admin/students', async (req) => {
  requireAdmin(req);
  const rows = await db.allStudents();
  const counts = await db.solvedCounts();
  return {
    rows: rows.map(s => ({ ...publicStudent(s), solved: counts.get(s.id) || 0, ip: s.ip, created_at: s.created_at, last_answer_at: s.last_answer_at })),
    total: TOTAL_Q, lessons: LESSONS.length, db: db.mode,
  };
});
route('DELETE', '/api/admin/students/:id', async (req, res, p) => { requireAdmin(req); return { ok: await db.deleteStudent(Number(p.id)) }; });
route('POST', '/api/admin/students/:id/reset', async (req, res, p) => { requireAdmin(req); await db.resetProgress(Number(p.id)); return { ok: true }; });
route('POST', '/api/admin/reload-questions', async (req) => {
  requireAdmin(req);
  try { loadCurriculum(); } catch (e) { throw new HttpError(400, 'خطأ في ملف المنهج: ' + e.message); }
  return { ok: true, total: TOTAL_Q };
});
route('GET', '/api/admin/export.csv', async (req, res) => {
  requireAdmin(req);
  const rows = await db.allStudents();
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['الترتيب', 'الاسم', 'الصف', 'صحيحة من أول محاولة', 'عدد المحاولات', 'النقاط', 'IP', 'تاريخ التسجيل'].map(esc).join(',')];
  rows.forEach((s, i) => lines.push([i + 1, s.name, s.grade, s.correct, s.answered, s.points, s.ip, new Date(s.created_at).toISOString()].map(esc).join(',')));
  send(res, 200, '﻿' + lines.join('\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="students.csv"' });
});

// ===== الملفات الثابتة =====
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'ممنوع' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'غير موجود' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  req.query = url.searchParams;
  req.ip = clientIp(req);
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'غير مسموح');
      return serveStatic(req, res, url.pathname);
    }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (m) {
        const out = await r.fn(req, res, m.groups || {});
        if (!res.headersSent) send(res, 200, out);
        return;
      }
    }
    throw new HttpError(404, 'غير موجود');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'خطأ في الخادم', ...(e.extra || {}) });
  }
});

db.init().then(() => {
  server.listen(PORT, () => console.log(`Math quiz running on http://localhost:${PORT}  (lessons: ${LESSONS.length}, questions: ${TOTAL_Q})`));
}).catch(e => { console.error('DB init failed', e); process.exit(1); });
