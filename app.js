const $ = s => document.querySelector(s);
const KEYS = ['أ', 'ب', 'ج', 'د'];
let me = null, map = null, curChapter = null, curLesson = null, current = null, reviewMode = false;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'حدث خطأ'); e.data = data; e.status = res.status; throw e; }
  return data;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// عرض الرياضيات: $...$ ، الكسر a/b ، الأس ^ ، الكسر الدوري .{3} ، **غامق**
function mathHtml(m) {
  return esc(m)
    .replace(/\.(\d*)\{(\d+)\}/g, '.$1<span class="ov">$2</span>')
    .replace(/(\d+(?:\.\d+)?)\/(\d+(?:\^−?\d+)?)/g, '<span class="frac"><span>$1</span><span>$2</span></span>')
    .replace(/\^\(([^)]+)\)|\^(−?[\d\wء-ي]+)/g, (_, a, b) => `<sup>${a || b}</sup>`);
}
function render(text) {
  return String(text).split('$').map((part, i) =>
    i % 2 ? `<span class="m" dir="${/[ء-ي]/.test(part) ? 'rtl' : 'ltr'}">${mathHtml(part)}</span>` : esc(part).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  ).join('');
}

function show(view) {
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'v-' + view);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === (view === 'board' ? 'board' : 'home')));
  window.scrollTo(0, 0);
}
const loading = () => show('loading');

async function refreshMe() {
  const m = await api('/api/me');
  if (m.student) {
    me = m.student;
    $('#h-name').textContent = me.name;
    $('#h-points').textContent = me.points;
    $('#h-rank').textContent = m.rank;
  }
  return m;
}

async function start() {
  loading();
  try {
    const cfg = await api('/api/config');
    const gsel = document.querySelector('#f-register select'), bsel = $('#b-grade');
    cfg.grades.forEach(g => { gsel.add(new Option(g, g)); bsel.add(new Option(g, g)); });
    const m = await refreshMe();
    if (m.student) return goHome();
    show(m.blocked ? 'blocked' : 'register');
  } catch (e) {
    $('#v-loading').innerHTML = '<p class="err">تعذر الاتصال. حدّث الصفحة.</p>';
  }
}

// ===== الفصول =====
async function loadMap() { map = await api('/api/map'); return map; }

async function goHome() {
  loading();
  await Promise.all([loadMap(), refreshMe()]);
  $('#chapters').innerHTML = map.chapters.map(ch => {
    const pct = Math.round(ch.done / ch.lessons.length * 100);
    return `<button class="bubble ${ch.status}" style="--c:${ch.color}" data-ch="${ch.id}" ${ch.status === 'locked' ? 'disabled' : ''}>
      <span class="b-icon">${ch.status === 'locked' ? '🔒' : esc(ch.icon)}</span>
      <span class="b-num">الفصل ${ch.num}</span>
      <span class="b-title">${esc(ch.title)}</span>
      <span class="b-prog"><i style="width:${pct}%"></i></span>
      <span class="b-count">${ch.done} / ${ch.lessons.length}</span>
    </button>`;
  }).join('');
  show('home');
}

function openChapter(id) {
  curChapter = map.chapters.find(c => c.id === id);
  $('#c-title').textContent = curChapter.title;
  $('#lessons').innerHTML = curChapter.lessons.map((l, i) => `
    <button class="node ${l.status}" style="--c:${curChapter.color}; --i:${i}" data-lesson="${l.id}" ${l.status === 'locked' ? 'disabled' : ''}>
      <span class="n-circle">${l.status === 'locked' ? '🔒' : l.status === 'done' ? '✓' : esc(l.num)}</span>
      <span class="n-title">${esc(l.title)}</span>
      ${l.status === 'open' && l.solved ? `<span class="n-prog">${l.solved} / ${l.total}</span>` : ''}
    </button>`).join('');
  show('chapter');
}

// ===== الدرس =====
async function openLesson(id) {
  loading();
  try {
    curLesson = await api('/api/lesson/' + id);
  } catch (e) { return goHome(); }
  if (curLesson.needsReview || !curLesson.started) return showLearn(curLesson.needsReview);
  nextQuestion();
}

function showLearn(review) {
  reviewMode = review;
  const L = curLesson.lesson, ex = L.explain;
  $('#l-title').textContent = L.num + ' ' + L.title;
  $('#l-review').hidden = !review;
  $('#l-idea').innerHTML = render(ex.idea);
  $('#l-rules').innerHTML = ex.rules.map(r => `<li>${render(r)}</li>`).join('');
  $('#l-examples').innerHTML = ex.examples.map((e, i) => `
    <div class="card example" data-ex="${i}">
      <div class="ex-head"><span class="ex-tag">مثال ${i + 1}</span></div>
      <p class="ex-q">${render(e.q)}</p>
      <ol class="steps">${e.steps.map(s => `<li hidden>${render(s)}</li>`).join('')}</ol>
      <p class="ex-a" hidden>الحل: ${render(e.a)}</p>
      <button class="btn step-btn">أظهر الخطوة ←</button>
    </div>`).join('');
  $('#l-start').textContent = review ? 'رجوع للأسئلة' : (curLesson.started ? 'متابعة الحل' : 'ابدأ الحل');
  show('learn');
}

$('#l-examples').onclick = e => {
  const btn = e.target.closest('.step-btn');
  if (!btn) return;
  const card = btn.closest('.example');
  const hidden = card.querySelector('.steps li[hidden]');
  if (hidden) { hidden.hidden = false; hidden.classList.add('pop'); }
  if (!card.querySelector('.steps li[hidden]')) {
    if (card.querySelector('.ex-a').hidden) { card.querySelector('.ex-a').hidden = false; btn.remove(); }
  }
};

$('#l-start').onclick = async () => {
  if (reviewMode) await api(`/api/lesson/${curLesson.lesson.id}/reviewed`, { method: 'POST' });
  curLesson.started = true; curLesson.needsReview = false;
  nextQuestion();
};

function hearts(mistakes, max) {
  return Array.from({ length: max }, (_, i) => `<span class="${i < max - mistakes ? 'on' : 'off'}">♥</span>`).join('');
}

async function nextQuestion() {
  loading();
  const id = curLesson.lesson.id;
  const r = await api(`/api/lesson/${id}/question`);
  if (r.review) { curLesson.needsReview = true; return showLearn(true); }
  if (r.done) return lessonDone(r.nextLessonId);
  current = r.question;
  const lvl = $('#q-level');
  lvl.textContent = current.levelName + (current.retry ? ' · محاولة جديدة' : '');
  lvl.className = 'level l' + current.level;
  $('#q-bar').style.width = (r.solved / r.total * 100) + '%';
  $('#q-hearts').innerHTML = hearts(r.mistakes, r.maxMistakes);
  $('#q-text').innerHTML = render(current.text);
  $('#q-choices').innerHTML = current.choices.map((c, i) =>
    `<button class="choice" data-i="${i}"><span class="k">${KEYS[i]}</span><span class="cv">${render(c)}</span></button>`).join('');
  $('#q-feedback').hidden = true;
  $('#q-next').hidden = true;
  show('quiz');
}

$('#q-choices').onclick = async e => {
  const b = e.target.closest('.choice');
  if (!b || b.disabled) return;
  const i = Number(b.dataset.i);
  const btns = [...document.querySelectorAll('.choice')];
  btns.forEach(x => x.disabled = true);
  try {
    const r = await api('/api/answer', { method: 'POST', body: { questionId: current.id, choice: i } });
    const fb = $('#q-feedback');
    $('#q-hearts').innerHTML = hearts(r.mistakes, r.maxMistakes);
    $('#q-bar').style.width = (r.lessonSolved / r.lessonTotal * 100) + '%';
    if (r.correct) {
      btns[i].classList.add('ok');
      fb.className = 'feedback ok';
      fb.innerHTML = `<b>✔ صحيح</b><br>${render(r.explanation)}`;
    } else {
      btns[i].classList.add('bad');
      fb.className = 'feedback bad';
      fb.innerHTML = r.review
        ? `<b>✘ خطأ — ٣ أخطاء</b><br>نرجع للشرح ثم نكمل.`
        : `<b>✘ خطأ</b><br>${render(curLesson.lesson.explain.tip)}<br><span class="muted small">سيعود هذا السؤال لاحقاً</span>`;
    }
    fb.hidden = false;
    me = r.student;
    const nb = $('#q-next');
    nb.textContent = r.review ? 'راجع الشرح ←' : r.lessonDone ? 'إنهاء الدرس ←' : 'التالي ←';
    nb.hidden = false;
    nb.focus();
  } catch (err) {
    if (err.status === 409) return nextQuestion();
    btns.forEach(x => x.disabled = false);
    alert(err.message);
  }
};
$('#q-next').onclick = nextQuestion;
$('#q-explain').onclick = () => showLearn(false);
$('#quiz-back').onclick = () => goHome().then(() => curChapter && openChapter(curChapter.id));
$('#learn-back').onclick = () => goHome().then(() => curChapter && openChapter(curChapter.id));

async function lessonDone(nextId) {
  await refreshMe();
  const btn = $('#d-next');
  btn.hidden = !nextId;
  btn.onclick = async () => {
    await loadMap();
    curChapter = map.chapters.find(c => c.lessons.some(l => l.id === nextId));
    openLesson(nextId);
  };
  show('done');
}

// ===== الصدارة =====
async function loadBoard() {
  const grade = $('#b-grade').value;
  const r = await api('/api/leaderboard' + (grade ? '?grade=' + encodeURIComponent(grade) : ''));
  $('#b-list').innerHTML = r.rows.map(s => `
    <li class="${me && s.id === me.id ? 'me' : ''}">
      <span class="r">${s.rank <= 3 ? ['🥇', '🥈', '🥉'][s.rank - 1] : s.rank}</span>
      <span class="n">${esc(s.name)}<span class="g">${esc(s.grade)}</span></span>
      <span class="sc"><b>${s.correct}</b> ✔ <span class="muted">· ${s.points} ★</span></span>
    </li>`).join('');
  $('#b-empty').hidden = r.rows.length > 0;
}

// ===== الأحداث =====
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  if (t.dataset.view === 'board') { show('board'); loadBoard(); }
  else if (me) goHome(); else start();
});
document.addEventListener('click', e => {
  const ch = e.target.closest('[data-ch]'); if (ch) return openChapter(ch.dataset.ch);
  const ls = e.target.closest('[data-lesson]'); if (ls) return openLesson(ls.dataset.lesson);
  const bk = e.target.closest('[data-back]'); if (bk) return goHome();
});
$('#b-grade').onchange = loadBoard;

$('#f-register').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target), btn = e.target.querySelector('button');
  $('#reg-err').textContent = ''; btn.disabled = true;
  try {
    const r = await api('/api/register', { method: 'POST', body: { name: f.get('name'), grade: f.get('grade') } });
    me = r.student; goHome();
  } catch (err) {
    if (err.data && err.data.blocked) show('blocked');
    else $('#reg-err').textContent = err.message;
  } finally { btn.disabled = false; }
};
$('#f-restore').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#restore-err').textContent = '';
  try {
    const r = await api('/api/restore', { method: 'POST', body: { name: f.get('name') } });
    me = r.student; goHome();
  } catch (err) { $('#restore-err').textContent = err.message; }
};

start();
