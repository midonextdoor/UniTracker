'use strict';

// State
let courses = [];
let initialized = false;

// Per-view filter state (persists across navigation)
const assignFilter = { course_id: null, status: 'all' };
let selectedCourseId = null;
let noteSearch = '';
let noteFilterCourse = null;

// Schedule + roadmap caches, refreshed on each render of their view
let scheduleEntries = [];
let scheduleCfg = { days: [0, 1, 2, 3, 4], start_hour: 8, end_hour: 20 };
let roadmapItems = [];
let dragSrcId = null;

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PALETTE = ['#10b981', '#3b82f6', '#f59e0b', '#f43f5e', '#8b5cf6', '#06b6d4'];

// Granularity of the suggestion list only. Typing is never restricted to it.
const TT_STEP = 5;

// Mirrors the CHECK constraints in db/schema.sql. Changing a value means
// editing the schema and the badge CSS too.
const STATUS_OPTS = [
  { v: 'todo',        label: 'To Do' },
  { v: 'in_progress', label: 'In Progress' },
  { v: 'done',        label: 'Done' },
];

const PRIORITY_OPTS = [
  { v: 'low',    label: 'Low' },
  { v: 'medium', label: 'Medium' },
  { v: 'high',   label: 'High' },
];

// `lead` prepends the sentinel row filters use for "no course selected".
// Labels stay raw; dropdown() escapes them on the way into the DOM.
function courseOptions(lead) {
  const list = courses.map(c => ({ v: String(c.id), label: c.name }));
  return lead ? [lead, ...list] : list;
}

// Bootstrap
async function init() {
  if (initialized) return;
  initialized = true;
  courses = await api('get_all_courses_simple');
  navigate();
}

window.addEventListener('pywebviewready', init);

// API helper
function api(method, ...args) {
  return window.pywebview.api[method](...args);
}

// Router
window.addEventListener('hashchange', navigate);

async function navigate() {
  ddClose();   // the outgoing view's anchors are about to be destroyed
  const view = location.hash.slice(1) || 'dashboard';
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  const content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading…</div>';
  try {
    switch (view) {
      case 'dashboard':   await renderDashboard();   break;
      case 'schedule':    await renderSchedule();    break;
      case 'courses':     await renderCourses();     break;
      case 'assignments': await renderAssignments(); break;
      case 'grades':      await renderGrades();      break;
      case 'notes':       await renderNotes();       break;
      case 'roadmap':     await renderRoadmap();     break;
      default:            await renderDashboard();
    }
  } catch (err) {
    content.innerHTML = emptyState('alert', String(err));
  }
}

// Utilities
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.slice(0, 10) + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const due   = new Date(iso.slice(0,10) + 'T00:00:00');
  return Math.ceil((due - today) / 86400000);
}

function dueDateBadge(iso) {
  if (!iso) return '';
  const d = daysUntil(iso);
  if (d < 0)  return `<span class="badge badge-overdue">${Math.abs(d)}d overdue</span>`;
  if (d === 0) return `<span class="badge badge-high">Today</span>`;
  if (d === 1) return `<span class="badge badge-medium">Tomorrow</span>`;
  return `<span style="color:var(--muted);font-size:13px">${fmtDate(iso)}</span>`;
}

function gradeColor(pct) {
  if (pct >= 90) return 'var(--accent)';
  if (pct >= 75) return 'var(--info)';
  if (pct >= 60) return 'var(--warn)';
  return 'var(--danger)';
}

function gradeLetterLabel(pct) {
  if (pct == null) return '';
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

// Icons / shared chrome
// References the <symbol> sprite defined at the top of index.html.
function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function emptyState(iconName, text, actionHTML = '') {
  return `<div class="empty-state">
    ${icon(iconName, 'empty-icon')}
    <div class="empty-text">${esc(text)}</div>
    ${actionHTML}
  </div>`;
}

function pageHeader(title, actionsHTML = '') {
  return `<div class="page-header">
    <h1 class="page-title">${esc(title)}</h1>
    <div class="header-actions">${actionsHTML}</div>
  </div>`;
}

// Time helpers (schedule)
function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

function minToHHMM(mins) {
  const m = Math.max(0, Math.min(24 * 60, Math.round(mins)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Stable per-course colour so every block for a course matches without picking.
function courseColor(courseId) {
  return PALETTE[Math.abs(Number(courseId) || 0) % PALETTE.length];
}

function entryColor(e) {
  return e.color || courseColor(e.course_id);
}

function hexA(hex, alpha) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Modal
const modal = document.getElementById('modal');

function openModal(title, bodyHTML) {
  // A panel anchored to the page would be stranded under the dialog's top layer.
  ddClose();
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  modal.showModal();
}

function closeModal() { modal.close(); }

modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

// Confirm dialog
// Replaces window.confirm(), which the webview draws in unthemeable OS chrome.
// Promise-based, so callers stay one line.
// `message` is inserted as HTML, so callers MUST esc() any user text.
const confirmEl = document.getElementById('confirm');
let confirmResolve = null;
let confirmResult = false;

function askConfirm(message, opts = {}) {
  document.getElementById('confirm-title').textContent = opts.title || 'Are you sure?';
  document.getElementById('confirm-text').innerHTML = message;
  const ok = document.getElementById('confirm-ok');
  const cancel = document.getElementById('confirm-cancel');
  ok.textContent = opts.okLabel || 'Delete';
  ok.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
  cancel.hidden = !!opts.hideCancel;
  confirmResult = false;
  confirmEl.showModal();
  // Cancel takes focus so a stray Enter cannot delete. With no Cancel there is
  // nothing destructive to guard, so OK takes it.
  (opts.hideCancel ? ok : cancel).focus();
  return new Promise(resolve => { confirmResolve = resolve; });
}

// One button, no destructive styling. Only for cases with no form open to put
// an inline error into; field validation should use showFormError().
function alertModal(message, opts = {}) {
  return askConfirm(message, {
    title: opts.title || 'Heads up',
    okLabel: opts.okLabel || 'OK',
    danger: false,
    hideCancel: true,
  });
}

function confirmYes() { confirmResult = true; confirmEl.close(); }
function confirmNo()  { confirmResult = false; confirmEl.close(); }

// Every dismissal path ends at `close`, so the promise settles exactly once.
confirmEl.addEventListener('close', () => {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(confirmResult);
});

confirmEl.addEventListener('click', e => { if (e.target === confirmEl) confirmNo(); });

// Dropdown
// Replaces every native <select>. Each instance renders a button plus a hidden
// <input> carrying the original element id, so `getElementById(id).value` still
// works.
//
// The shared panel is `fixed` so it escapes `.modal-box`'s overflow clipping,
// and is appended to the open <dialog> so it paints in the top layer.
const DD = {};
let ddOpenId = null;
let ddActive = -1;
let ddPanel = null;
let ddTypeBuf = '';
let ddTypeAt = 0;

function dropdown(id, options, value, opts = {}) {
  const list = options.map(o => ({ v: String(o.v), label: String(o.label) }));
  DD[id] = { options: list, onChange: opts.onChange || null, kind: 'select' };
  const val = value == null ? '' : String(value);
  const sel = list.find(o => o.v === val);
  const label = sel ? sel.label : (opts.placeholder || (list[0] ? list[0].label : ''));
  return `<div class="dd${opts.compact ? ' dd-compact' : ''}">
    <button type="button" class="dd-btn" id="ddb-${id}" onclick="ddToggle('${id}')"
      onkeydown="ddBtnKey(event,'${id}')" aria-haspopup="listbox" aria-expanded="false">
      <span class="dd-label" id="ddl-${id}">${esc(label)}</span>
      ${icon('chevron-down', 'dd-caret')}
    </button>
    <input type="hidden" id="${id}" value="${esc(val)}">
  </div>`;
}

function ddAnchor(id) {
  const cfg = DD[id];
  if (!cfg) return null;
  return document.getElementById(cfg.kind === 'time' ? id : 'ddb-' + id);
}

function ddHost() { return modal.open ? modal : document.body; }

function ddToggle(id) {
  if (ddOpenId === id) ddClose();
  else ddOpen(id);
}

function ddBtnKey(e, id) {
  if (ddOpenId === id) return;
  if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
    e.preventDefault();
    ddOpen(id);
  }
}

function ddOpen(id) {
  const cfg = DD[id];
  const anchor = ddAnchor(id);
  if (!cfg || !anchor) return;
  ddClose();
  ddOpenId = id;

  const cur = String(document.getElementById(id).value);
  if (!ddPanel) {
    ddPanel = document.createElement('div');
    ddPanel.className = 'dd-panel';
    ddPanel.setAttribute('role', 'listbox');
  }
  ddPanel.innerHTML = cfg.options.map((o, i) =>
    `<div class="dd-opt${o.v === cur ? ' selected' : ''}" role="option"
       aria-selected="${o.v === cur}" onmousedown="event.preventDefault()"
       onclick="ddPick('${id}',${i})"><span class="dd-opt-label">${esc(o.label)}</span>${
         icon('check', 'dd-check')}</div>`).join('');

  ddHost().appendChild(ddPanel);
  let found = cfg.options.findIndex(o => o.v === cur);
  if (found < 0 && cfg.kind === 'time') {
    // A freely typed time (09:07) is in no slot, so highlight the nearest one.
    const mins = ttParse(cur);
    if (mins != null) found = Math.min(cfg.options.length - 1, Math.round(mins / TT_STEP));
  }
  ddActive = found >= 0 ? found : 0;
  ddPosition(anchor);
  ddPaintActive();
  ddScrollActive();
  if (cfg.kind === 'select') anchor.setAttribute('aria-expanded', 'true');
}

function ddPosition(anchor) {
  const r = anchor.getBoundingClientRect();
  ddPanel.style.minWidth = r.width + 'px';
  ddPanel.style.top = '0px';
  ddPanel.style.left = '0px';
  const h = ddPanel.offsetHeight;
  const w = ddPanel.offsetWidth;
  const gap = 6;
  let top = r.bottom + gap;
  if (top + h > window.innerHeight - 8 && r.top - h - gap > 8) top = r.top - h - gap;
  ddPanel.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
  ddPanel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
}

function ddClose() {
  if (!ddOpenId) return;
  const anchor = ddAnchor(ddOpenId);
  if (anchor && DD[ddOpenId].kind === 'select') anchor.setAttribute('aria-expanded', 'false');
  if (ddPanel && ddPanel.parentNode) ddPanel.parentNode.removeChild(ddPanel);
  ddOpenId = null;
  ddActive = -1;
  ddTypeBuf = '';
}

function ddPaintActive() {
  if (!ddPanel) return;
  Array.from(ddPanel.children).forEach((el, i) => el.classList.toggle('active', i === ddActive));
}

function ddScrollActive() {
  const el = ddPanel && ddPanel.children[ddActive];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function ddSetValue(id, v) {
  const input = document.getElementById(id);
  if (input) input.value = v;
  const cfg = DD[id];
  const label = document.getElementById('ddl-' + id);
  if (label && cfg) {
    const o = cfg.options.find(x => x.v === String(v));
    label.textContent = o ? o.label : v;
  }
}

function ddPick(id, i) {
  const cfg = DD[id];
  const o = cfg && cfg.options[i];
  if (!o) return;
  ddSetValue(id, o.v);
  ddClose();
  const anchor = ddAnchor(id);
  if (anchor) anchor.focus();
  if (cfg.onChange) cfg.onChange(o.v);
}

function ddMove(delta) {
  const n = DD[ddOpenId].options.length;
  ddActive = Math.max(0, Math.min(n - 1, ddActive + delta));
  ddPaintActive();
  ddScrollActive();
  // A time field behaves as a combobox: arrowing writes through to the input.
  if (DD[ddOpenId].kind === 'time') ddSetValue(ddOpenId, DD[ddOpenId].options[ddActive].v);
}

// Capture phase so Escape reaches us before the dialog's native cancel.
document.addEventListener('keydown', e => {
  if (!ddOpenId) return;
  const cfg = DD[ddOpenId];
  switch (e.key) {
    case 'Escape':
      e.preventDefault(); e.stopPropagation(); ddClose(); return;
    case 'ArrowDown': e.preventDefault(); ddMove(1); return;
    case 'ArrowUp':   e.preventDefault(); ddMove(-1); return;
    case 'Home':
    case 'End':
      // A time field is a text input first, so caret movement stays the browser's.
      if (cfg.kind === 'time') return;
      e.preventDefault();
      ddActive = e.key === 'Home' ? 0 : cfg.options.length - 1;
      ddPaintActive();
      ddScrollActive();
      return;
    case 'Enter':
      e.preventDefault();
      if (cfg.kind === 'time') { ddClose(); ttNormalize(ddOpenId); }
      else ddPick(ddOpenId, ddActive);
      return;
    case 'Tab': ddClose(); return;
  }
  // Typeahead is select-only; a time field needs its printable keys.
  if (cfg.kind === 'select' && e.key.length === 1) {
    const now = Date.now();
    ddTypeBuf = (now - ddTypeAt < 800 ? ddTypeBuf : '') + e.key.toLowerCase();
    ddTypeAt = now;
    const i = cfg.options.findIndex(o => o.label.toLowerCase().startsWith(ddTypeBuf));
    if (i >= 0) { ddActive = i; ddPaintActive(); ddScrollActive(); }
  }
}, true);

document.addEventListener('mousedown', e => {
  if (!ddOpenId) return;
  if (ddPanel && ddPanel.contains(e.target)) return;
  const anchor = ddAnchor(ddOpenId);
  const wrap = anchor && anchor.closest('.dd');
  if (wrap && wrap.contains(e.target)) return;
  ddClose();
}, true);

// Keep the panel pinned to its field rather than closing on scroll.
document.addEventListener('scroll', () => {
  const anchor = ddOpenId && ddAnchor(ddOpenId);
  if (anchor) ddPosition(anchor);
}, true);

window.addEventListener('resize', ddClose);
modal.addEventListener('close', ddClose);
// Without this, Escape inside an open dropdown would dismiss the whole modal.
modal.addEventListener('cancel', e => { if (ddOpenId) { e.preventDefault(); ddClose(); } });

// Time field
// A text input first, dropdown second. The panel only suggests; any minute can
// be typed (09:07 is valid even though it is not in the list).
//
// No `maxlength`: a full "09:00" would otherwise refuse every keystroke until
// the field was cleared by hand.
function timeField(id, value, onChange) {
  const opts = Array.from({ length: (24 * 60) / TT_STEP }, (_, i) => {
    const v = minToHHMM(i * TT_STEP);
    return { v, label: v };
  });
  DD[id] = { options: opts, onChange: onChange || null, kind: 'time' };
  return `<div class="dd tt">
    <input type="text" class="tt-input" id="${id}" value="${esc(value)}"
      inputmode="numeric" autocomplete="off" placeholder="HH:MM"
      title="Type a time (9, 930, 9:20) or pick one from the list"
      onfocus="ttOpen('${id}')" onclick="ttOpen('${id}')"
      oninput="ttSync('${id}')" onblur="ttBlur('${id}')">
    <button type="button" class="tt-caret" tabindex="-1" aria-label="Choose time"
      onclick="ddToggle('${id}')">${icon('chevron-down')}</button>
  </div>`;
}

function ttOpen(id) {
  if (ddOpenId !== id) ddOpen(id);
}

// Follow along as the user types, without hijacking the keystrokes.
function ttSync(id) {
  if (ddOpenId !== id) return;
  const mins = ttParse(document.getElementById(id).value);
  if (mins == null) return;
  const last = DD[id].options.length - 1;
  ddActive = Math.max(0, Math.min(last, Math.round(mins / TT_STEP)));
  ddPaintActive();
  ddScrollActive();
}

function ttBlur(id) {
  ttNormalize(id);
  const cfg = DD[id];
  if (cfg && cfg.onChange) cfg.onChange(document.getElementById(id).value);
}

// "9" -> 09:00, "930" -> 09:30, "9:5" -> 09:05. Returns minutes, or null.
function ttParse(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  let h, m;
  const colon = s.match(/^(\d{1,2}):(\d{1,2})$/);
  if (colon) { h = +colon[1]; m = +colon[2]; }
  else if (/^\d{1,2}$/.test(s)) { h = +s; m = 0; }
  else if (/^\d{3,4}$/.test(s)) { h = +s.slice(0, s.length - 2); m = +s.slice(-2); }
  else return null;
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function ttNormalize(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const mins = ttParse(el.value);
  if (mins != null) el.value = minToHHMM(mins);
}

// Dashboard
async function renderDashboard() {
  const data = await api('get_dashboard');
  const content = document.getElementById('content');

  const upcomingHTML = data.upcoming.length === 0
    ? `<div class="empty-state empty-inline">${icon('check-circle', 'empty-icon')}
        <div class="empty-text">No deadlines in the next 14 days</div></div>`
    : `<div class="deadline-list">
        ${data.upcoming.map(a => `
          <div class="deadline-item">
            <span class="deadline-date">${dueDateBadge(a.due_date)}</span>
            <span class="deadline-title">${esc(a.title)}</span>
            <span class="deadline-course">${esc(a.course_name)}</span>
            <span class="badge badge-${a.priority}">${a.priority}</span>
          </div>`).join('')}
      </div>`;

  const gradeHTML = data.grade_avgs.length === 0 ? '' : `
    <div class="section-title" style="margin-top:28px">Grade Averages</div>
    <div class="cards-grid">
      ${data.grade_avgs.map(c => {
        const pct = c.avg_grade;
        return `<div class="card">
          <div class="card-title">${esc(c.name)}</div>
          <div style="display:flex;align-items:baseline;gap:10px;margin-top:10px">
            <span style="font-size:26px;font-weight:700;color:${gradeColor(pct)}">${pct}%</span>
            <span style="font-size:14px;color:var(--muted)">${gradeLetterLabel(pct)}</span>
          </div>
          <div class="progress-bar" style="margin-top:10px">
            <div class="progress-fill" style="width:${Math.min(pct,100)}%;background:${gradeColor(pct)}"></div>
          </div>
        </div>`;
      }).join('')}
    </div>`;

  content.innerHTML = `
    ${pageHeader('Dashboard')}
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Courses</div>
        <div class="stat-value accent">${data.courses_count}</div></div>
      <div class="stat-card"><div class="stat-label">Pending</div>
        <div class="stat-value">${data.pending_count}</div></div>
      <div class="stat-card"><div class="stat-label">Overdue</div>
        <div class="stat-value ${data.overdue_count > 0 ? 'danger' : ''}">${data.overdue_count}</div></div>
      <div class="stat-card"><div class="stat-label">Due in 14 days</div>
        <div class="stat-value warn">${data.upcoming.length}</div></div>
    </div>
    <div class="section-title">Upcoming Deadlines</div>
    ${upcomingHTML}
    ${gradeHTML}
  `;
}

// Courses
async function renderCourses() {
  const data = await api('get_courses');
  const content = document.getElementById('content');

  const cardsHTML = data.length === 0
    ? emptyState('book', 'No courses yet. Add your first one.')
    : `<div class="cards-grid">
        ${data.map(c => {
          const pct = c.avg_grade;
          const metaParts = [c.code, c.instructor, c.semester, `${c.credits} cr`].filter(Boolean);
          return `
            <div class="card">
              <div class="card-title">${esc(c.name)}</div>
              <div class="card-meta">${esc(metaParts.join(' · '))}</div>
              <div style="display:flex;gap:16px;font-size:13px">
                <span style="color:var(--muted)">${c.pending_count} pending</span>
                ${pct != null ? `<span style="color:${gradeColor(pct)};font-weight:600">${pct}% avg</span>` : ''}
              </div>
              ${pct != null ? `
                <div class="progress-bar" style="margin-top:10px">
                  <div class="progress-fill" style="width:${Math.min(pct,100)}%;background:${gradeColor(pct)}"></div>
                </div>` : ''}
              <div class="card-actions">
                <button class="btn btn-ghost btn-sm" onclick="openEditCourse(${c.id})">Edit</button>
                <button class="btn btn-ghost btn-sm"
                  onclick="showCourseAssignments(${c.id})">Assignments</button>
                <button class="btn btn-danger btn-sm" onclick="deleteCourse(${c.id})">Delete</button>
              </div>
            </div>`;
        }).join('')}
      </div>`;

  content.innerHTML = `
    ${pageHeader('Courses',
      `<button class="btn btn-primary" onclick="openAddCourse()">${icon('plus')}Add Course</button>`)}
    ${cardsHTML}
  `;
}

function courseFormHTML(c = {}) {
  return `<div class="form">
    <div class="form-row"><label>Course Name *</label>
      <input id="f-name" type="text" value="${esc(c.name || '')}"
        oninput="showFormError('')"></div>
    <div class="form-row"><label>Course Code</label>
      <input id="f-code" type="text" value="${esc(c.code || '')}" placeholder="e.g. CS101"></div>
    <div class="form-row"><label>Instructor</label>
      <input id="f-instructor" type="text" value="${esc(c.instructor || '')}"></div>
    <div class="form-row"><label>Semester</label>
      <input id="f-semester" type="text" value="${esc(c.semester || '')}" placeholder="e.g. Fall 2025"></div>
    <div class="form-row"><label>Credits</label>
      <input id="f-credits" type="number" value="${c.credits ?? 3}" min="0" max="30"></div>
    <div id="f-error" class="form-error"></div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="f-save" onclick="saveCourse(${c.id ?? 'null'})">Save</button>
    </div>
  </div>`;
}

function openAddCourse() { openModal('Add Course', courseFormHTML()); }

async function openEditCourse(id) {
  const all = await api('get_courses');
  const c = all.find(x => x.id === id);
  if (c) openModal('Edit Course', courseFormHTML(c));
}

async function saveCourse(id) {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { showFormError('Course name is required.'); return; }
  const data = {
    name,
    code:       document.getElementById('f-code').value.trim(),
    instructor: document.getElementById('f-instructor').value.trim(),
    semester:   document.getElementById('f-semester').value.trim(),
    credits:    parseInt(document.getElementById('f-credits').value) || 3,
  };
  if (id) await api('update_course', id, data);
  else    await api('add_course', data);
  courses = await api('get_all_courses_simple');
  closeModal();
  renderCourses();
}

async function deleteCourse(id) {
  const c = courses.find(x => x.id === id);
  if (!await askConfirm(
    `Delete ${c ? `<strong>${esc(c.name)}</strong>` : 'this course'}? Its assignments, grades and
     schedule entries go with it. Notes are kept, just unlinked from the course.`,
    { title: 'Delete course' })) return;
  await api('delete_course', id);
  courses = await api('get_all_courses_simple');
  renderCourses();
}

// Shortcut from a course card into #assignments, pre-filtered to that course.
// Deliberately leaves assignFilter.status alone; this is a jump, not a reset.
// The hash change routes through navigate(), so a failed load lands in its catch.
function showCourseAssignments(id) {
  assignFilter.course_id = id;
  location.hash = '#assignments';
}

// Assignments
async function renderAssignments() {
  const data = await api('get_assignments', assignFilter.course_id, assignFilter.status);
  const content = document.getElementById('content');

  const tableHTML = data.length === 0
    ? emptyState('clipboard', 'No assignments found')
    : `<div class="table-wrap"><table>
        <thead><tr>
          <th>Title</th><th>Course</th><th>Due</th><th>Priority</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>
          ${data.map(a => `<tr>
            <td>${esc(a.title)}${a.notes ? `<br><span style="font-size:11px;color:var(--muted)">${esc(a.notes.slice(0,60))}${a.notes.length>60?'…':''}</span>` : ''}</td>
            <td style="color:var(--accent);font-size:13px">${esc(a.course_name)}</td>
            <td>${dueDateBadge(a.due_date)}</td>
            <td><span class="badge badge-${a.priority}">${a.priority}</span></td>
            <td>
              ${dropdown(`st-${a.id}`, STATUS_OPTS, a.status,
                { compact: true, onChange: v => quickStatus(a.id, v) })}
            </td>
            <td>
              <div style="display:flex;gap:6px">
                <button class="btn btn-ghost btn-sm" onclick="openEditAssignment(${a.id})">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="deleteAssignment(${a.id})">Del</button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>`;

  content.innerHTML = `
    ${pageHeader('Assignments',
      `<button class="btn btn-primary" onclick="openAddAssignment()">${icon('plus')}Add Assignment</button>`)}
    <div class="filters">
      ${dropdown('flt-course', courseOptions({ v: '', label: 'All Courses' }), assignFilter.course_id,
        { compact: true, onChange: v => { assignFilter.course_id = v || null; renderAssignments(); } })}
      <div class="tabs">
        ${['all','todo','in_progress','done'].map(s =>
          `<button class="tab ${assignFilter.status===s?'active':''}"
            onclick="assignFilter.status='${s}';renderAssignments()">
            ${s==='all'?'All':s==='in_progress'?'In Progress':s.charAt(0).toUpperCase()+s.slice(1)}
          </button>`).join('')}
      </div>
    </div>
    ${tableHTML}
  `;
}

async function quickStatus(id, status) {
  const all = await api('get_assignments', null, null);
  const a = all.find(x => x.id === id);
  if (a) { a.status = status; await api('update_assignment', id, a); }
  renderAssignments();
}

function assignmentFormHTML(a = {}) {
  return `<div class="form">
    <div class="form-row"><label>Course *</label>
      ${dropdown('f-course', courseOptions(), a.course_id ?? courses[0].id)}</div>
    <div class="form-row"><label>Title *</label>
      <input id="f-title" type="text" value="${esc(a.title || '')}"
        oninput="showFormError('')"></div>
    <div class="form-row"><label>Due Date</label>
      <input id="f-due" type="date" value="${a.due_date ? a.due_date.slice(0,10) : ''}"></div>
    <div class="form-row"><label>Priority</label>
      ${dropdown('f-priority', PRIORITY_OPTS, a.priority || 'medium')}</div>
    <div class="form-row"><label>Status</label>
      ${dropdown('f-status', STATUS_OPTS, a.status || 'todo')}</div>
    <div class="form-row"><label>Notes</label>
      <textarea id="f-notes">${esc(a.notes || '')}</textarea></div>
    <div id="f-error" class="form-error"></div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="f-save" onclick="saveAssignment(${a.id ?? 'null'})">Save</button>
    </div>
  </div>`;
}

function openAddAssignment() {
  if (!courses.length) {
    alertModal('Add a course first. Every assignment has to belong to one.',
      { title: 'No courses yet' });
    return;
  }
  openModal('Add Assignment', assignmentFormHTML());
}

async function openEditAssignment(id) {
  const all = await api('get_assignments', null, null);
  const a = all.find(x => x.id === id);
  if (a) openModal('Edit Assignment', assignmentFormHTML(a));
}

async function saveAssignment(id) {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { showFormError('Title is required.'); return; }
  const data = {
    course_id: parseInt(document.getElementById('f-course').value),
    title,
    due_date:  document.getElementById('f-due').value || null,
    priority:  document.getElementById('f-priority').value,
    status:    document.getElementById('f-status').value,
    notes:     document.getElementById('f-notes').value.trim(),
  };
  if (id) await api('update_assignment', id, data);
  else    await api('add_assignment', data);
  closeModal();
  renderAssignments();
}

async function deleteAssignment(id) {
  if (!await askConfirm('Delete this assignment?', { title: 'Delete assignment' })) return;
  await api('delete_assignment', id);
  renderAssignments();
}

// Grades
async function renderGrades() {
  const content = document.getElementById('content');
  if (!courses.length) {
    content.innerHTML = emptyState('chart', 'Add a course first');
    return;
  }
  if (!selectedCourseId) selectedCourseId = courses[0].id;

  const data = await api('get_grades', selectedCourseId);

  const avg = data.weighted_avg;
  const avgBox = avg != null
    ? `<div class="grade-avg-box">
        <div>
          <div class="grade-big" style="color:${gradeColor(avg)}">${avg}%</div>
          <div class="grade-sub">${data.total_weight > 0 ? 'Weighted average · '+data.total_weight+'% assigned' : 'Simple average'}</div>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${Math.min(avg,100)}%;background:${gradeColor(avg)}"></div>
        </div>
        <div style="font-size:32px;font-weight:700;color:${gradeColor(avg)}">${gradeLetterLabel(avg)}</div>
      </div>`
    : `<div class="grade-avg-box"><div class="grade-sub">No grades recorded yet</div></div>`;

  const tableHTML = data.grades.length === 0
    ? emptyState('chart', 'No grade entries yet')
    : `<div class="table-wrap"><table>
        <thead><tr>
          <th>Assessment</th><th>Grade</th><th>Max</th><th>Score</th><th>Weight</th><th></th>
        </tr></thead>
        <tbody>
          ${data.grades.map(g => {
            const pct = g.grade != null ? g.grade / g.max_grade * 100 : null;
            return `<tr>
              <td>${esc(g.assessment_name)}</td>
              <td>${g.grade != null ? g.grade : ''}</td>
              <td>${g.max_grade}</td>
              <td style="color:${pct != null ? gradeColor(pct) : 'var(--muted)'};font-weight:600">
                ${pct != null ? pct.toFixed(1)+'%' : ''}
              </td>
              <td style="color:var(--muted)">${g.weight > 0 ? g.weight+'%' : ''}</td>
              <td>
                <div style="display:flex;gap:6px">
                  <button class="btn btn-ghost btn-sm" onclick="openEditGrade(${g.id})">Edit</button>
                  <button class="btn btn-danger btn-sm" onclick="deleteGrade(${g.id})">Del</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>`;

  content.innerHTML = `
    ${pageHeader('Grades',
      `<button class="btn btn-primary" onclick="openAddGrade()">${icon('plus')}Add Grade</button>`)}
    <div class="filters">
      ${dropdown('flt-grade-course', courseOptions(), selectedCourseId,
        { compact: true, onChange: v => { selectedCourseId = parseInt(v); renderGrades(); } })}
    </div>
    ${avgBox}
    ${tableHTML}
  `;
}

function gradeFormHTML(g = {}) {
  return `<div class="form">
    <div class="form-row"><label>Assessment Name *</label>
      <input id="f-name" type="text" value="${esc(g.assessment_name || '')}"
        placeholder="e.g. Midterm Exam" oninput="showFormError('')"></div>
    <div class="form-row"><label>Grade Received</label>
      <input id="f-grade" type="number" step="0.01" oninput="showFormError('')" value="${g.grade != null ? g.grade : ''}" placeholder="Leave blank if not yet graded"></div>
    <div class="form-row"><label>Max Grade</label>
      <input id="f-max" type="number" step="0.01" oninput="showFormError('')" value="${g.max_grade ?? 100}"></div>
    <div class="form-row"><label>Weight (%) <span style="color:var(--muted);font-weight:400">0 = unweighted</span></label>
      <input id="f-weight" type="number" step="0.01" oninput="showFormError('')" value="${g.weight ?? 0}"></div>
    <div id="f-error" class="form-error"></div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="f-save" onclick="saveGrade(${g.id ?? 'null'})">Save</button>
    </div>
  </div>`;
}

function openAddGrade() { openModal('Add Grade', gradeFormHTML()); }

async function openEditGrade(id) {
  const data = await api('get_grades', selectedCourseId);
  const g = data.grades.find(x => x.id === id);
  if (g) openModal('Edit Grade', gradeFormHTML(g));
}

async function saveGrade(id) {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { showFormError('Assessment name is required.'); return; }
  const gradeStr = document.getElementById('f-grade').value.trim();
  const data = {
    course_id:       selectedCourseId,
    assessment_name: name,
    grade:           gradeStr === '' ? null : parseFloat(gradeStr),
    max_grade:       parseFloat(document.getElementById('f-max').value) || 100,
    weight:          parseFloat(document.getElementById('f-weight').value) || 0,
  };
  const res = id ? await api('update_grade', id, data) : await api('add_grade', data);
  if (res && res.error) { showFormError(res.error); return; }
  closeModal();
  renderGrades();
}

async function deleteGrade(id) {
  if (!await askConfirm('Delete this grade entry? The course average will be recalculated.',
    { title: 'Delete grade' })) return;
  await api('delete_grade', id);
  renderGrades();
}

// Notes
async function renderNotes() {
  const all = await api('get_notes', noteFilterCourse);
  const data = noteSearch
    ? all.filter(n =>
        n.title.toLowerCase().includes(noteSearch) ||
        (n.content || '').toLowerCase().includes(noteSearch))
    : all;

  const content = document.getElementById('content');
  const cardsHTML = data.length === 0
    ? emptyState('note', 'No notes found')
    : `<div class="cards-grid">
        ${data.map(n => `
          <div class="note-card" onclick="openEditNote(${n.id})">
            <div class="card-title">${esc(n.title)}</div>
            ${n.course_name ? `<div class="note-course-tag">${esc(n.course_name)}</div>` : ''}
            <div class="note-preview">${esc(n.content || '')}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px">
              <span class="note-date">${fmtDate(n.created_at ? n.created_at.slice(0,10) : null)}</span>
              <button class="btn btn-danger btn-sm"
                onclick="event.stopPropagation();deleteNote(${n.id})">Delete</button>
            </div>
          </div>`).join('')}
      </div>`;

  content.innerHTML = `
    ${pageHeader('Notes',
      `<button class="btn btn-primary" onclick="openAddNote()">${icon('plus')}Add Note</button>`)}
    <div class="filters">
      <input type="text" placeholder="Search notes…" value="${esc(noteSearch)}"
        oninput="noteSearch=this.value.toLowerCase();renderNotes()">
      ${dropdown('flt-note-course', courseOptions({ v: '', label: 'All Courses' }), noteFilterCourse,
        { compact: true, onChange: v => { noteFilterCourse = v || null; renderNotes(); } })}
    </div>
    ${cardsHTML}
  `;
}

function noteFormHTML(n = {}) {
  return `<div class="form">
    <div class="form-row"><label>Title *</label>
      <input id="f-title" type="text" value="${esc(n.title || '')}"
        oninput="showFormError('')"></div>
    <div class="form-row"><label>Course (optional)</label>
      ${dropdown('f-course', courseOptions({ v: '', label: 'General (no course)' }), n.course_id)}</div>
    <div class="form-row"><label>Content</label>
      <textarea id="f-content" style="min-height:200px">${esc(n.content || '')}</textarea></div>
    <div id="f-error" class="form-error"></div>
    <div class="form-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="f-save" onclick="saveNote(${n.id ?? 'null'})">Save</button>
    </div>
  </div>`;
}

function openAddNote() { openModal('Add Note', noteFormHTML()); }

async function openEditNote(id) {
  const all = await api('get_notes', null);
  const n = all.find(x => x.id === id);
  if (n) openModal('Edit Note', noteFormHTML(n));
}

async function saveNote(id) {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { showFormError('Title is required.'); return; }
  const data = {
    title,
    course_id: document.getElementById('f-course').value || null,
    content:   document.getElementById('f-content').value,
  };
  if (id) await api('update_note', id, data);
  else    await api('add_note', data);
  closeModal();
  renderNotes();
}

async function deleteNote(id) {
  if (!await askConfirm('Delete this note? This cannot be undone.',
    { title: 'Delete note' })) return;
  await api('delete_note', id);
  renderNotes();
}

// Schedule
const SLOT_H = 28;   // px per 30-minute row

async function renderSchedule() {
  const content = document.getElementById('content');
  scheduleCfg = await api('get_schedule_settings');

  if (!courses.length) {
    content.innerHTML = pageHeader('Schedule') + emptyState('calendar', 'Add a course first');
    return;
  }
  scheduleEntries = await api('get_schedule');

  const days = scheduleCfg.days;
  const winStart = scheduleCfg.start_hour * 60;
  const winEnd = scheduleCfg.end_hour * 60;
  const span = winEnd - winStart;
  const slots = Math.ceil(span / 30);

  const shown = scheduleEntries.filter(e =>
    days.includes(e.day_of_week) &&
    toMin(e.end_time) > winStart && toMin(e.start_time) < winEnd);
  const hidden = scheduleEntries.length - shown.length;

  const gutter = `<div class="sched-gutter">${
    Array.from({ length: slots }, (_, i) => {
      const m = winStart + i * 30;
      return `<div class="sched-slot ${m % 60 === 0 ? 'is-hour' : ''}">
        ${m % 60 === 0 ? `<span class="sched-tick">${minToHHMM(m)}</span>` : ''}
      </div>`;
    }).join('')}</div>`;

  const cols = days.map(d => {
    const slotCells = Array.from({ length: slots }, (_, i) => {
      const m = winStart + i * 30;
      return `<div class="sched-slot ${m % 60 === 0 ? 'is-hour' : ''}"
        onclick="openAddSchedule(${d}, '${minToHHMM(m)}')"></div>`;
    }).join('');

    const blocks = shown.filter(e => e.day_of_week === d).map(e => {
      const s = Math.max(toMin(e.start_time), winStart);
      const en = Math.min(toMin(e.end_time), winEnd);
      const dur = toMin(e.end_time) - toMin(e.start_time);
      const c = entryColor(e);
      const label = e.course_code || e.course_name;
      const range = `${e.start_time}–${e.end_time}`;
      return `<div class="sched-block" data-size="${dur < 45 ? 'xs' : dur < 75 ? 'sm' : 'md'}"
        style="top:${(s - winStart) / span * 100}%;height:${(en - s) / span * 100}%;
               background:${hexA(c, .16)};border-left-color:${c}"
        title="${esc(`${e.course_name} · ${range}${e.note ? ' · ' + e.note : ''}`)}"
        onclick="openEditSchedule(${e.id})">
        <div class="sb-title" style="color:${c}">${esc(label)}</div>
        ${e.note ? `<div class="sb-note">${esc(e.note)}</div>` : ''}
        <div class="sb-time">${esc(range)}</div>
      </div>`;
    }).join('');

    return `<div class="sched-col">
      <div class="sched-slots">${slotCells}</div>
      <div class="sched-blocks">${blocks}</div>
    </div>`;
  }).join('');

  content.innerHTML = `
    ${pageHeader('Schedule', `
      <button class="btn btn-ghost" onclick="openScheduleSettings()">${icon('sliders')}Configure</button>
      <button class="btn btn-primary" onclick="openAddSchedule()">${icon('plus')}Add Class</button>`)}
    <div class="sched-wrap" style="--cols:${days.length}">
      <div class="sched-head">
        <div class="sched-corner"></div>
        ${days.map(d => `<div class="sched-dayname">${DAY_SHORT[d]}</div>`).join('')}
      </div>
      <div class="sched-body">${gutter}${cols}</div>
    </div>
    <div class="sched-foot">
      <span>Click any slot to add a class.</span>
      ${hidden > 0
        ? `<span class="sched-hidden">${icon('alert')}${hidden} ${hidden === 1 ? 'entry' : 'entries'} outside the current view</span>`
        : ''}
    </div>`;
}

function scheduleFormHTML(e = {}, prefill = {}) {
  // The Day dropdown offers only the configured week, so a class can't be filed
  // onto a day the grid doesn't draw. get_schedule_settings() guarantees days is
  // a non-empty sorted 0-6 list, so cfgDays[0] is always a real option, which
  // dropdown() requires, or the hidden input saves as "" and Number() gives NaN.
  const cfgDays = scheduleCfg.days;
  let day = e.day_of_week ?? prefill.day ?? cfgDays[0];
  if (!cfgDays.includes(day)) day = cfgDays[0];
  const start = e.start_time || prefill.start || '09:00';
  const end = e.end_time || prefill.end || minToHHMM(toMin(start) + 60);
  const cid = e.course_id ?? courses[0].id;

  // Every field re-runs the overlap check; ttBlur normalizes before firing this,
  // so checkSchedule always reads a settled HH:MM.
  const recheck = () => checkSchedule(e.id ?? null);
  const swatches = PALETTE.map(c =>
    `<button type="button" class="swatch ${e.color === c ? 'active' : ''}" data-c="${c}"
       style="background:${c}" onclick="pickColor('${c}')" aria-label="Colour ${c}"></button>`).join('');

  return `<div class="form">
    <div class="form-row"><label>Course *</label>
      ${dropdown('f-course', courseOptions(), cid, { onChange: recheck })}</div>
    <div class="form-row"><label>Day</label>
      ${dropdown('f-day', cfgDays.map(i => ({ v: i, label: DAY_NAMES[i] })), day,
        { onChange: recheck })}</div>
    <div class="form-grid-2">
      <div class="form-row"><label>Start <span class="label-hint">type or pick</span></label>
        ${timeField('f-start', start, recheck)}</div>
      <div class="form-row"><label>End <span class="label-hint">type or pick</span></label>
        ${timeField('f-end', end, recheck)}</div>
    </div>
    <div class="form-row"><label>Note <span class="label-hint">optional</span></label>
      <input id="f-note" type="text" value="${esc(e.note || '')}" placeholder="e.g. Lab, Room 204"></div>
    <div class="form-row"><label>Colour</label>
      <input type="hidden" id="f-color" value="${esc(e.color || '')}">
      <div class="swatches">
        <button type="button" class="swatch swatch-auto ${e.color ? '' : 'active'}" data-c=""
          onclick="pickColor('')">Auto</button>
        ${swatches}
      </div></div>
    <div id="f-error" class="form-error"></div>
    <div class="form-actions">
      ${e.id ? `<button class="btn btn-danger" onclick="deleteSchedule(${e.id})">Delete</button>` : ''}
      <div class="spacer"></div>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="f-save" onclick="saveSchedule(${e.id ?? 'null'})">Save</button>
    </div>
  </div>`;
}

function pickColor(hex) {
  document.getElementById('f-color').value = hex;
  document.querySelectorAll('.swatch').forEach(el =>
    el.classList.toggle('active', el.dataset.c === hex));
}

// Mirrors the server-side overlap rule so Save can be blocked before a round trip.
function checkSchedule(id) {
  const day = Number(document.getElementById('f-day').value);
  const s = document.getElementById('f-start').value;
  const e = document.getElementById('f-end').value;
  let msg = '';
  if (!s || !e) {
    msg = 'Start and end times are required.';
  } else if (toMin(e) <= toMin(s)) {
    msg = 'End time must be after start time.';
  } else {
    const clash = scheduleEntries.find(x =>
      x.id !== id && x.day_of_week === day &&
      toMin(x.start_time) < toMin(e) && toMin(x.end_time) > toMin(s));
    if (clash) {
      msg = `Overlaps ${clash.course_code || clash.course_name} (${clash.start_time} – ${clash.end_time})`;
    }
  }
  showFormError(msg);
  return !msg;
}

function showFormError(msg) {
  const el = document.getElementById('f-error');
  const save = document.getElementById('f-save');
  if (!el) return;
  el.innerHTML = msg ? `${icon('alert')}<span>${esc(msg)}</span>` : '';
  el.classList.toggle('visible', !!msg);
  if (save) save.disabled = !!msg;
}

function openAddSchedule(day, start) {
  if (!courses.length) {
    alertModal('Add a course first. Every class on the schedule has to belong to one.',
      { title: 'No courses yet' });
    return;
  }
  const prefill = day == null ? {} : { day, start, end: minToHHMM(toMin(start) + 60) };
  openModal('Add Class', scheduleFormHTML({}, prefill));
  checkSchedule(null);
}

function openEditSchedule(id) {
  const e = scheduleEntries.find(x => x.id === id);
  if (e) { openModal('Edit Class', scheduleFormHTML(e)); checkSchedule(id); }
}

async function saveSchedule(id) {
  if (!checkSchedule(id)) return;
  const data = {
    course_id: Number(document.getElementById('f-course').value),
    day_of_week: Number(document.getElementById('f-day').value),
    start_time: document.getElementById('f-start').value,
    end_time: document.getElementById('f-end').value,
    note: document.getElementById('f-note').value.trim(),
    color: document.getElementById('f-color').value || null,
  };
  const res = id
    ? await api('update_schedule_entry', id, data)
    : await api('add_schedule_entry', data);
  if (res && res.error) { showFormError(res.error); return; }
  closeModal();
  renderSchedule();
}

async function deleteSchedule(id) {
  const e = scheduleEntries.find(x => x.id === id);
  if (!await askConfirm(
    e ? `Remove <strong>${esc(e.course_name)}</strong> (${esc(DAY_SHORT[e.day_of_week])}
         ${esc(e.start_time)}–${esc(e.end_time)}) from the schedule?`
      : 'Remove this class from the schedule?',
    { title: 'Remove class', okLabel: 'Remove' })) return;
  await api('delete_schedule_entry', id);
  closeModal();
  renderSchedule();
}

// Schedule settings
// The live day selection while the modal is open. Held here rather than read
// back out of the DOM, so the toggle row can repaint without losing state.
let settingsDays = [];

// "All week" / "Mon–Fri" for a contiguous run / otherwise a plain list.
function daysSummary(days) {
  if (!days.length) return 'no days selected';
  if (days.length === 7) return 'all week';
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  return contiguous && days.length > 2
    ? `${DAY_SHORT[days[0]]}–${DAY_SHORT[days[days.length - 1]]}`
    : days.map(d => DAY_SHORT[d]).join(', ');
}

function hourValue(id) {
  return Number(document.getElementById(id).value);
}

// Repaints just the toggle row, leaving the hour dropdowns (and any open panel
// anchored to them) untouched.
function renderDaysSection() {
  const row = document.getElementById('f-days');
  if (row) {
    row.innerHTML = DAY_SHORT.map((n, i) => {
      const on = settingsDays.includes(i);
      return `<button type="button" class="day-toggle${on ? ' active' : ''}"
        aria-pressed="${on}" onclick="toggleSettingsDay(${i})">${n}</button>`;
    }).join('');
  }
  renderSettingsSummary();
}

function renderSettingsSummary() {
  const el = document.getElementById('f-summary');
  if (!el) return;
  const span = hourValue('f-end-hour') - hourValue('f-start-hour');
  el.textContent = span > 0
    ? `Showing ${span} ${span === 1 ? 'hour' : 'hours'}, ${daysSummary(settingsDays)}`
    : 'End hour must be after start hour';
  // Clears a stale server-side error and re-enables Save after any edit.
  showFormError('');
}

function toggleSettingsDay(i) {
  settingsDays = settingsDays.includes(i)
    ? settingsDays.filter(d => d !== i)
    : [...settingsDays, i].sort((a, b) => a - b);
  renderDaysSection();
}

function setDaysPreset(kind) {
  settingsDays = kind === 'all' ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4];
  renderDaysSection();
}

function openScheduleSettings() {
  settingsDays = [...scheduleCfg.days];
  const hours = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => ({
    v: from + k,
    label: `${String(from + k).padStart(2, '0')}:00`,
  }));

  openModal('Schedule Settings', `<div class="form">
    <div class="form-row">
      <label>Days shown</label>
      <div class="day-toggles" id="f-days"></div>
      <div class="day-presets">
        <button class="btn btn-ghost btn-sm" onclick="setDaysPreset('weekdays')">Weekdays</button>
        <button class="btn btn-ghost btn-sm" onclick="setDaysPreset('all')">All 7</button>
      </div>
    </div>
    <div class="form-divider"></div>
    <div class="form-row">
      <label>Visible hours</label>
      <div class="hour-range">
        ${dropdown('f-start-hour', hours(0, 23), scheduleCfg.start_hour,
          { onChange: renderSettingsSummary })}
        <span class="to">to</span>
        ${dropdown('f-end-hour', hours(1, 24), scheduleCfg.end_hour,
          { onChange: renderSettingsSummary })}
      </div>
      <div class="settings-summary" id="f-summary"></div>
    </div>
    <div id="f-error" class="form-error"></div>
    <div class="form-actions">
      <div class="spacer"></div>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="f-save" onclick="saveScheduleSettings()">Save</button>
    </div>
  </div>`);
  renderDaysSection();
}

async function saveScheduleSettings() {
  const res = await api('save_schedule_settings', {
    days: settingsDays,
    start_hour: hourValue('f-start-hour'),
    end_hour: hourValue('f-end-hour'),
  });
  if (res && res.error) { showFormError(res.error); return; }
  scheduleCfg = res;
  closeModal();
  renderSchedule();
}

// Roadmap
async function renderRoadmap() {
  roadmapItems = await api('get_roadmap');
  const content = document.getElementById('content');
  const done = roadmapItems.filter(i => i.is_completed).length;
  const total = roadmapItems.length;
  const pct = total ? Math.round(done / total * 100) : 0;

  const listHTML = total === 0
    ? emptyState('roadmap', 'No roadmap items yet. Add your first step.')
    : `<div class="roadmap-list">${roadmapItems.map((it, i) => `
        <div class="rm-item ${it.is_completed ? 'done' : ''}" draggable="true"
          ondragstart="rmDragStart(event, ${it.id})" ondragover="rmDragOver(event)"
          ondragleave="rmDragLeave(event)" ondrop="rmDrop(event, ${it.id})"
          ondragend="rmDragEnd(event)">
          <span class="rm-grip" title="Drag to reorder">${icon('grip')}</span>
          <button class="rm-check" onclick="toggleRoadmap(${it.id})"
            aria-label="Toggle complete">${it.is_completed ? icon('check') : ''}</button>
          <div class="rm-body" onclick="openEditRoadmap(${it.id})">
            <div class="rm-title">${esc(it.title)}</div>
            ${it.description ? `<div class="rm-desc">${esc(it.description)}</div>` : ''}
          </div>
          <div class="rm-actions">
            <button class="icon-btn" onclick="moveRoadmap(${it.id}, -1)"
              ${i === 0 ? 'disabled' : ''} aria-label="Move up">${icon('chevron-up')}</button>
            <button class="icon-btn" onclick="moveRoadmap(${it.id}, 1)"
              ${i === total - 1 ? 'disabled' : ''} aria-label="Move down">${icon('chevron-down')}</button>
            <button class="icon-btn is-danger" onclick="deleteRoadmap(${it.id})"
              aria-label="Delete">${icon('trash')}</button>
          </div>
        </div>`).join('')}</div>`;

  content.innerHTML = `
    ${pageHeader('Roadmap',
      `<button class="btn btn-primary" onclick="openAddRoadmap()">${icon('plus')}Add Item</button>`)}
    ${total ? `<div class="rm-progress">
      <div class="rm-progress-text"><span>${done} of ${total} complete</span><span>${pct}%</span></div>
      <div class="progress-bar"><div class="progress-fill"
        style="width:${pct}%;background:var(--accent)"></div></div>
    </div>` : ''}
    ${listHTML}`;
}

function roadmapFormHTML(it = {}) {
  return `<div class="form">
    <div class="form-row"><label>Title *</label>
      <input id="f-title" type="text" value="${esc(it.title || '')}"
        oninput="showFormError('')"></div>
    <div class="form-row"><label>Description <span class="label-hint">optional</span></label>
      <textarea id="f-desc">${esc(it.description || '')}</textarea></div>
    <div id="f-error" class="form-error"></div>
    <div class="form-actions">
      ${it.id ? `<button class="btn btn-danger" onclick="deleteRoadmap(${it.id})">Delete</button>` : ''}
      <div class="spacer"></div>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="f-save" onclick="saveRoadmap(${it.id ?? 'null'})">Save</button>
    </div>
  </div>`;
}

function openAddRoadmap() { openModal('Add Roadmap Item', roadmapFormHTML()); }

function openEditRoadmap(id) {
  const it = roadmapItems.find(x => x.id === id);
  if (it) openModal('Edit Roadmap Item', roadmapFormHTML(it));
}

async function saveRoadmap(id) {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { showFormError('Title is required.'); return; }
  const data = { title, description: document.getElementById('f-desc').value.trim() };
  if (id) {
    const existing = roadmapItems.find(x => x.id === id);
    data.is_completed = existing ? existing.is_completed : false;
    await api('update_roadmap_item', id, data);
  } else {
    await api('add_roadmap_item', data);
  }
  closeModal();
  renderRoadmap();
}

async function toggleRoadmap(id) {
  await api('toggle_roadmap_item', id);
  renderRoadmap();
}

async function deleteRoadmap(id) {
  const it = roadmapItems.find(x => x.id === id);
  if (!await askConfirm(
    it ? `Delete <strong>${esc(it.title)}</strong> from the roadmap?`
       : 'Delete this roadmap item?',
    { title: 'Delete roadmap item' })) return;
  await api('delete_roadmap_item', id);
  closeModal();
  renderRoadmap();
}

// Arrows and drag-and-drop both funnel through the same persist call.
async function persistRoadmapOrder(ids) {
  await api('reorder_roadmap', ids);
  renderRoadmap();
}

async function moveRoadmap(id, delta) {
  const ids = roadmapItems.map(i => i.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  await persistRoadmapOrder(ids);
}

function rmDragStart(ev, id) {
  dragSrcId = id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.currentTarget.classList.add('dragging');
}

function rmDragOver(ev) {
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  ev.currentTarget.classList.add('drop-target');
}

function rmDragLeave(ev) { ev.currentTarget.classList.remove('drop-target'); }

function rmDragEnd() {
  dragSrcId = null;
  document.querySelectorAll('.rm-item')
    .forEach(el => el.classList.remove('dragging', 'drop-target'));
}

function rmDrop(ev, targetId) {
  ev.preventDefault();
  rmDragEnd();
  if (dragSrcId === null || dragSrcId === targetId) return;
  const ids = roadmapItems.map(i => i.id);
  const from = ids.indexOf(dragSrcId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  persistRoadmapOrder(ids);
}

// Uni Portal
async function openPortal() {
  const { url } = await api('get_portal_url');
  if (!url) { openPortalSettings(); return; }
  const res = await api('open_portal');
  if (res && res.error) openPortalSettings();
}

async function openPortalSettings() {
  const { url } = await api('get_portal_url');
  openModal('Uni Portal', `<div class="form">
    <div class="form-row"><label>Portal URL</label>
      <input id="f-portal" type="text" value="${esc(url)}" placeholder="portal.university.edu">
      <div class="label-hint" style="margin-top:6px">
        Opens in your default browser. http:// or https:// only.</div></div>
    <div id="f-error" class="form-error"></div>
    <div class="form-actions">
      <div class="spacer"></div>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="f-save" onclick="savePortal()">Save</button>
    </div>
  </div>`);
}

async function savePortal() {
  const res = await api('save_portal_url', document.getElementById('f-portal').value.trim());
  if (res && res.error) { showFormError(res.error); return; }
  closeModal();
}
