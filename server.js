'use strict';
/**
 * 갓생게임 서버
 * Node.js 표준 모듈만 사용합니다. 설치 없이 `node server.js`로 실행하세요.
 * 저장소:
 *  - SUPABASE_URL과 SUPABASE_SERVICE_KEY 환경 변수가 있으면 Supabase(app_state 테이블)에 저장합니다. (배포용)
 *  - 없으면 data/db.json 파일에 저장합니다. (로컬용)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_KEY || '').trim();
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);
const STATE_ID = process.env.STATE_ID || 'main';

/* ------------------------------------------------------------------ */
/* 게임 규칙                                                            */
/* ------------------------------------------------------------------ */
const XP_TABLE = {
  daily: { easy: 10, normal: 20, hard: 35 },
  weekly: { easy: 40, normal: 70, hard: 120 },
};
const PERFECT_DAY_BONUS = 15;
const QUEST_LIMIT = { daily: 20, weekly: 10 };
const CATEGORIES = ['health', 'study', 'life', 'mind', 'work'];
const DIFFICULTIES = ['easy', 'normal', 'hard'];
const TYPES = ['daily', 'weekly'];
const MAX_FRIENDS = 100;
const TITLES = [
  [35, '전설의 갓생러'],
  [20, '갓생 마스터'],
  [10, '습관 장인'],
  [5, '루틴 수련생'],
  [1, '갓생 새싹'],
];

const xpForNext = (level) => 100 + (level - 1) * 40;
function levelInfo(totalXp) {
  let level = 1;
  let rest = Math.max(0, totalXp);
  while (rest >= xpForNext(level)) {
    rest -= xpForNext(level);
    level += 1;
  }
  return { level, xp: rest, xpNext: xpForNext(level) };
}
const titleFor = (level) => TITLES.find(([min]) => level >= min)[1];

/* ------------------------------------------------------------------ */
/* 날짜 — 초기화는 한국 시간 기준                                        */
/* ------------------------------------------------------------------ */
const KST_OFFSET = 9 * 60 * 60 * 1000;
const dayKey = (t = Date.now()) => new Date(t + KST_OFFSET).toISOString().slice(0, 10);
function shiftDay(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekKey(t = Date.now()) {
  const today = dayKey(t);
  const mondayIndex = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 월=0 … 일=6
  return shiftDay(today, -mondayIndex);
}
const periodKey = (type) => (type === 'daily' ? dayKey() : weekKey());

/* ------------------------------------------------------------------ */
/* 저장소 (JSON 파일)                                                   */
/* ------------------------------------------------------------------ */
const emptyDb = () => ({ users: {}, sessions: {}, quests: {}, requests: {} });
let db = emptyDb();

const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
});

async function loadDb() {
  if (USE_SUPABASE) {
    // 읽기에 실패하면 서버를 시작하지 않습니다. 빈 데이터로 덮어써서 기록을 잃는 일을 막기 위해서예요.
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.${encodeURIComponent(STATE_ID)}&select=data`, {
      headers: supabaseHeaders(),
    });
    if (!res.ok) throw new Error(`Supabase에서 데이터를 읽지 못했어요 (${res.status}): ${await res.text()}`);
    const rows = await res.json();
    if (rows.length && rows[0].data) db = { ...emptyDb(), ...rows[0].data };
    return;
  }
  if (!fs.existsSync(DB_FILE)) return;
  try {
    db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch (err) {
    const backup = `${DB_FILE}.broken-${Date.now()}`;
    console.error(`[db] 데이터 파일을 읽지 못했어요. ${backup}에 백업하고 새로 시작합니다.`, err.message);
    try { fs.copyFileSync(DB_FILE, backup); } catch { /* 백업 실패는 무시 */ }
    db = emptyDb();
  }
}

async function writeState(json) {
  if (USE_SUPABASE) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: `{"id":${JSON.stringify(STATE_ID)},"updated_at":"${new Date().toISOString()}","data":${json}}`,
    });
    if (!res.ok) throw new Error(`Supabase에 저장하지 못했어요 (${res.status}): ${await res.text()}`);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, DB_FILE);
  } catch {
    // OneDrive 같은 동기화 폴더에서 rename이 막히면 바로 씁니다.
    fs.writeFileSync(DB_FILE, json);
  }
}

// 변경 사항은 요청이 끝날 때 한 번에, 순서대로 저장합니다.
let dirty = false;
let writeChain = Promise.resolve();
function saveDb() {
  dirty = true;
}
function flushDb() {
  if (!dirty) return writeChain;
  dirty = false;
  const json = JSON.stringify(db);
  const p = writeChain.then(() => writeState(json));
  writeChain = p.catch((err) => {
    dirty = true;
    console.error('[db]', err.message);
  });
  return p;
}

/* ------------------------------------------------------------------ */
/* 공통 도구                                                            */
/* ------------------------------------------------------------------ */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const charLength = (s) => [...s].length;
const cleanText = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, user) {
  const a = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외 (32자)
function newFriendCode() {
  const taken = new Set(Object.values(db.users).map((u) => u.code));
  for (;;) {
    const body = [...crypto.randomBytes(6)].map((b) => CODE_ALPHABET[b % 32]).join('');
    const code = `GS-${body}`;
    if (!taken.has(code)) return code;
  }
}
function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.length === 8 && raw.startsWith('GS') ? raw.slice(2) : raw;
  return `GS-${body}`;
}

function validNickname(input) {
  const nickname = cleanText(input);
  if (charLength(nickname) < 1 || charLength(nickname) > 12) {
    throw new HttpError(400, '닉네임은 1–12자로 입력해 주세요');
  }
  return nickname;
}
function validBio(input) {
  const bio = cleanText(input);
  if (charLength(bio) > 40) throw new HttpError(400, '한 줄 소개는 40자까지 쓸 수 있어요');
  return bio;
}
function validTitle(input) {
  const title = cleanText(input);
  if (charLength(title) < 1) throw new HttpError(400, '퀘스트 이름을 입력해 주세요');
  if (charLength(title) > 40) throw new HttpError(400, '퀘스트 이름은 40자까지 쓸 수 있어요');
  return title;
}
function validTarget(type, input) {
  if (type === 'daily') return 1;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 7) throw new HttpError(400, '주간 목표 횟수는 1–7회로 정해 주세요');
  return n;
}
function oneOf(value, list, message) {
  if (!list.includes(value)) throw new HttpError(400, message);
  return value;
}

/* ------------------------------------------------------------------ */
/* 퀘스트 · 통계                                                        */
/* ------------------------------------------------------------------ */
const questsOf = (userId) =>
  Object.values(db.quests)
    .filter((q) => q.userId === userId)
    .sort((a, b) => a.createdAt - b.createdAt);
const entryOf = (q) => q.log[periodKey(q.type)] || { c: 0, xp: 0 };
const isDone = (q) => entryOf(q).c >= q.target;

function questView(q) {
  const e = entryOf(q);
  return {
    id: q.id,
    title: q.title,
    type: q.type,
    difficulty: q.difficulty,
    category: q.category,
    target: q.target,
    progress: Math.min(e.c, q.target),
    done: e.c >= q.target,
    reward: XP_TABLE[q.type][q.difficulty],
    createdAt: q.createdAt,
  };
}

function streakInfo(user) {
  const set = new Set(user.perfectDays);
  const today = dayKey();
  let current = 0;
  let cursor = set.has(today) ? today : shiftDay(today, -1);
  while (set.has(cursor)) {
    current += 1;
    cursor = shiftDay(cursor, -1);
  }
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of [...set].sort()) {
    run = prev && shiftDay(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best };
}

function weekDays(user) {
  const start = weekKey();
  const today = dayKey();
  const set = new Set(user.perfectDays);
  return Array.from({ length: 7 }, (_, i) => {
    const key = shiftDay(start, i);
    return { key, perfect: set.has(key), today: key === today, future: key > today };
  });
}

function statsOf(user) {
  const lv = levelInfo(user.totalXp);
  const st = streakInfo(user);
  const qs = questsOf(user.id);
  const daily = qs.filter((q) => q.type === 'daily');
  const weekly = qs.filter((q) => q.type === 'weekly');
  return {
    level: lv.level,
    xp: lv.xp,
    xpNext: lv.xpNext,
    totalXp: user.totalXp,
    title: titleFor(lv.level),
    streak: st.current,
    bestStreak: st.best,
    completedCount: user.completedCount,
    today: { done: daily.filter(isDone).length, total: daily.length, perfect: user.perfectDays.includes(dayKey()) },
    week: { done: weekly.filter(isDone).length, total: weekly.length, days: weekDays(user) },
    friendCount: Object.keys(user.friends).length,
  };
}

const publicProfile = (user) => ({
  id: user.id,
  nickname: user.nickname,
  bio: user.bio,
  code: user.code,
  createdAt: user.createdAt,
  ...statsOf(user),
});

function meView(user) {
  const today = dayKey();
  const cheersToday = user.cheers
    .filter((c) => c.day === today)
    .map((c) => db.users[c.from]?.nickname)
    .filter(Boolean);
  return { ...publicProfile(user), username: user.username, cheersToday };
}

const stateOf = (user) => ({ me: meView(user), quests: questsOf(user.id).map(questView) });

/**
 * 오늘의 일일 퀘스트가 모두 끝났는지 확인하고 올클리어 보너스를 주거나 회수합니다.
 * allowRevoke=false면 보너스를 주기만 합니다 (퀘스트 삭제 때 이미 받은 기록을 지키기 위해).
 */
function syncPerfectDay(user, allowRevoke = true) {
  const today = dayKey();
  const daily = questsOf(user.id).filter((q) => q.type === 'daily');
  const perfectNow = daily.length > 0 && daily.every(isDone);
  const had = user.perfectDays.includes(today);
  if (perfectNow && !had) {
    user.perfectDays.push(today);
    user.totalXp += PERFECT_DAY_BONUS;
    return PERFECT_DAY_BONUS;
  }
  if (!perfectNow && had && allowRevoke) {
    user.perfectDays = user.perfectDays.filter((d) => d !== today);
    user.totalXp = Math.max(0, user.totalXp - PERFECT_DAY_BONUS);
    return -PERFECT_DAY_BONUS;
  }
  return 0;
}

function pruneLog(q) {
  const keys = Object.keys(q.log).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 30))) delete q.log[k];
}

function ownQuest(user, id) {
  const q = db.quests[id];
  if (!q || q.userId !== user.id) throw new HttpError(404, '퀘스트를 찾지 못했어요');
  return q;
}

/* ------------------------------------------------------------------ */
/* 친구                                                                 */
/* ------------------------------------------------------------------ */
const brief = (u) => {
  const lv = levelInfo(u.totalXp);
  return { id: u.id, nickname: u.nickname, code: u.code, level: lv.level, title: titleFor(lv.level) };
};

function friendSummary(viewer, friend) {
  return {
    ...publicProfile(friend),
    since: viewer.friends[friend.id],
    cheeredToday: friend.cheers.some((c) => c.from === viewer.id && c.day === dayKey()),
  };
}

function friendsPayload(user, extra = {}) {
  const friends = Object.keys(user.friends)
    .map((id) => db.users[id])
    .filter(Boolean)
    .map((f) => friendSummary(user, f));
  const requests = Object.values(db.requests).sort((a, b) => b.createdAt - a.createdAt);
  const incoming = requests
    .filter((r) => r.to === user.id && db.users[r.from])
    .map((r) => ({ id: r.id, createdAt: r.createdAt, user: brief(db.users[r.from]) }));
  const outgoing = requests
    .filter((r) => r.from === user.id && db.users[r.to])
    .map((r) => ({ id: r.id, createdAt: r.createdAt, user: brief(db.users[r.to]) }));
  return { ...extra, me: meView(user), friends, incoming, outgoing };
}

function makeFriends(a, b) {
  const now = Date.now();
  a.friends[b.id] = now;
  b.friends[a.id] = now;
  for (const r of Object.values(db.requests)) {
    if ((r.from === a.id && r.to === b.id) || (r.from === b.id && r.to === a.id)) delete db.requests[r.id];
  }
}

function friendOf(user, id) {
  const f = db.users[id];
  if (!f || !user.friends[id]) throw new HttpError(404, '친구 목록에 없는 사용자예요');
  return f;
}

/* ------------------------------------------------------------------ */
/* 라우트                                                               */
/* ------------------------------------------------------------------ */
const routes = [];
function route(method, pattern, handler, { auth = true } = {}) {
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  routes.push({ method, re, handler, auth });
}

// 상태 확인 (배포 서비스의 헬스 체크용)
route('GET', '/api/health', () => ({ ok: true, storage: USE_SUPABASE ? 'supabase' : 'file' }), { auth: false });

// 인증
route('POST', '/api/auth/signup', ({ body }) => {
  const username = String(body.username || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{4,16}$/.test(username)) {
    throw new HttpError(400, '아이디는 영문 소문자, 숫자, _를 써서 4–16자로 만들어 주세요');
  }
  const password = String(body.password || '');
  if (password.length < 6 || password.length > 64) throw new HttpError(400, '비밀번호는 6–64자로 입력해 주세요');
  const nickname = validNickname(body.nickname);
  if (Object.values(db.users).some((u) => u.username === username)) {
    throw new HttpError(409, '이미 사용 중인 아이디예요');
  }
  const { salt, hash } = hashPassword(password);
  const user = {
    id: uid('u'),
    username,
    passwordHash: hash,
    salt,
    nickname,
    bio: '',
    code: newFriendCode(),
    createdAt: Date.now(),
    totalXp: 0,
    completedCount: 0,
    perfectDays: [],
    friends: {},
    cheers: [],
  };
  db.users[user.id] = user;
  const token = issueToken(user);
  saveDb();
  return { token, ...stateOf(user) };
}, { auth: false });

route('POST', '/api/auth/login', ({ body }) => {
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const user = Object.values(db.users).find((u) => u.username === username);
  if (!user || !verifyPassword(password, user)) throw new HttpError(400, '아이디 또는 비밀번호가 맞지 않아요');
  const token = issueToken(user);
  saveDb();
  return { token, ...stateOf(user) };
}, { auth: false });

route('POST', '/api/auth/logout', ({ tokenHash }) => {
  delete db.sessions[tokenHash];
  saveDb();
  return { ok: true };
});

// 내 정보
route('GET', '/api/me', ({ user }) => stateOf(user));

route('PATCH', '/api/me', ({ user, body }) => {
  if ('nickname' in body) user.nickname = validNickname(body.nickname);
  if ('bio' in body) user.bio = validBio(body.bio);
  saveDb();
  return stateOf(user);
});

route('DELETE', '/api/me', ({ user, body }) => {
  if (!verifyPassword(String(body.password || ''), user)) throw new HttpError(400, '비밀번호가 맞지 않아요');
  for (const q of questsOf(user.id)) delete db.quests[q.id];
  for (const r of Object.values(db.requests)) if (r.from === user.id || r.to === user.id) delete db.requests[r.id];
  for (const [hash, s] of Object.entries(db.sessions)) if (s.userId === user.id) delete db.sessions[hash];
  for (const fid of Object.keys(user.friends)) if (db.users[fid]) delete db.users[fid].friends[user.id];
  delete db.users[user.id];
  saveDb();
  return { ok: true };
});

// 퀘스트
route('POST', '/api/quests', ({ user, body }) => {
  const type = oneOf(body.type, TYPES, '퀘스트 종류를 골라 주세요');
  const count = questsOf(user.id).filter((q) => q.type === type).length;
  if (count >= QUEST_LIMIT[type]) {
    throw new HttpError(400, `${type === 'daily' ? '일일' : '주간'} 퀘스트는 ${QUEST_LIMIT[type]}개까지 만들 수 있어요`);
  }
  const q = {
    id: uid('q'),
    userId: user.id,
    title: validTitle(body.title),
    type,
    difficulty: oneOf(body.difficulty, DIFFICULTIES, '난이도를 골라 주세요'),
    category: oneOf(body.category, CATEGORIES, '카테고리를 골라 주세요'),
    target: validTarget(type, body.target),
    createdAt: Date.now(),
    log: {},
  };
  db.quests[q.id] = q;
  saveDb();
  return stateOf(user);
});

route('PATCH', '/api/quests/:id', ({ user, body, params }) => {
  const q = ownQuest(user, params.id);
  if ('title' in body) q.title = validTitle(body.title);
  if ('difficulty' in body) q.difficulty = oneOf(body.difficulty, DIFFICULTIES, '난이도를 골라 주세요');
  if ('category' in body) q.category = oneOf(body.category, CATEGORIES, '카테고리를 골라 주세요');
  if ('target' in body && q.type === 'weekly') {
    const target = validTarget('weekly', body.target);
    const key = periodKey(q.type);
    const e = q.log[key];
    // 이미 받은 XP는 그대로 두고, 진행 상태만 새 목표에 맞춥니다.
    if (e) e.c = e.xp > 0 ? target : Math.min(e.c, target - 1);
    q.target = target;
  }
  saveDb();
  return stateOf(user);
});

route('DELETE', '/api/quests/:id', ({ user, params }) => {
  const q = ownQuest(user, params.id);
  delete db.quests[q.id];
  const gained = q.type === 'daily' ? syncPerfectDay(user, false) : 0;
  saveDb();
  return { ...stateOf(user), gained, perfect: gained > 0 };
});

route('POST', '/api/quests/:id/progress', ({ user, body, params }) => {
  const q = ownQuest(user, params.id);
  const delta = Number(body.delta);
  if (delta !== 1 && delta !== -1) throw new HttpError(400, '잘못된 요청이에요');
  const key = periodKey(q.type);
  const entry = q.log[key] || { c: 0, xp: 0 };
  const levelBefore = levelInfo(user.totalXp).level;
  let gained = 0;

  if (delta > 0) {
    if (entry.c >= q.target) return { ...stateOf(user), gained: 0, leveledUp: null, perfect: false };
    entry.c += 1;
    if (entry.c >= q.target) {
      entry.xp = XP_TABLE[q.type][q.difficulty];
      user.totalXp += entry.xp;
      user.completedCount += 1;
      gained += entry.xp;
    }
  } else {
    if (entry.c <= 0) return { ...stateOf(user), gained: 0, leveledUp: null, perfect: false };
    if (entry.c >= q.target && entry.xp > 0) {
      user.totalXp = Math.max(0, user.totalXp - entry.xp);
      user.completedCount = Math.max(0, user.completedCount - 1);
      gained -= entry.xp;
      entry.xp = 0;
    }
    entry.c -= 1;
  }
  q.log[key] = entry;
  pruneLog(q);

  let bonus = 0;
  if (q.type === 'daily') bonus = syncPerfectDay(user);
  gained += bonus;

  const levelAfter = levelInfo(user.totalXp).level;
  saveDb();
  return {
    ...stateOf(user),
    gained,
    bonus,
    perfect: bonus > 0,
    leveledUp: levelAfter > levelBefore ? levelAfter : null,
  };
});

// 친구
route('GET', '/api/friends', ({ user }) => friendsPayload(user));

route('POST', '/api/friends/requests', ({ user, body }) => {
  const code = normalizeCode(body.code);
  const target = Object.values(db.users).find((u) => u.code === code);
  if (!target) throw new HttpError(404, '이 고유 ID를 가진 사용자를 찾지 못했어요');
  if (target.id === user.id) throw new HttpError(400, '내 고유 ID는 추가할 수 없어요');
  if (user.friends[target.id]) throw new HttpError(409, '이미 친구예요');
  if (Object.keys(user.friends).length >= MAX_FRIENDS || Object.keys(target.friends).length >= MAX_FRIENDS) {
    throw new HttpError(400, `친구는 ${MAX_FRIENDS}명까지 추가할 수 있어요`);
  }
  const reqs = Object.values(db.requests);
  if (reqs.some((r) => r.from === target.id && r.to === user.id)) {
    makeFriends(user, target);
    saveDb();
    return friendsPayload(user, { result: 'accepted', nickname: target.nickname });
  }
  if (reqs.some((r) => r.from === user.id && r.to === target.id)) throw new HttpError(409, '이미 친구 요청을 보냈어요');
  const r = { id: uid('r'), from: user.id, to: target.id, createdAt: Date.now() };
  db.requests[r.id] = r;
  saveDb();
  return friendsPayload(user, { result: 'sent', nickname: target.nickname });
});

function incomingRequest(user, id) {
  const r = db.requests[id];
  if (!r || r.to !== user.id) throw new HttpError(404, '요청을 찾지 못했어요');
  return r;
}

route('POST', '/api/friends/requests/:id/accept', ({ user, params }) => {
  const r = incomingRequest(user, params.id);
  const other = db.users[r.from];
  if (!other) {
    delete db.requests[r.id];
    saveDb();
    throw new HttpError(404, '탈퇴한 사용자예요');
  }
  if (Object.keys(user.friends).length >= MAX_FRIENDS) throw new HttpError(400, `친구는 ${MAX_FRIENDS}명까지 추가할 수 있어요`);
  makeFriends(user, other);
  saveDb();
  return friendsPayload(user, { nickname: other.nickname });
});

route('POST', '/api/friends/requests/:id/decline', ({ user, params }) => {
  const r = incomingRequest(user, params.id);
  delete db.requests[r.id];
  saveDb();
  return friendsPayload(user);
});

route('DELETE', '/api/friends/requests/:id', ({ user, params }) => {
  const r = db.requests[params.id];
  if (!r || r.from !== user.id) throw new HttpError(404, '요청을 찾지 못했어요');
  delete db.requests[r.id];
  saveDb();
  return friendsPayload(user);
});

route('GET', '/api/friends/:id', ({ user, params }) => ({ friend: friendSummary(user, friendOf(user, params.id)) }));

route('DELETE', '/api/friends/:id', ({ user, params }) => {
  const f = friendOf(user, params.id);
  delete user.friends[f.id];
  delete f.friends[user.id];
  saveDb();
  return friendsPayload(user);
});

route('POST', '/api/friends/:id/cheer', ({ user, params }) => {
  const f = friendOf(user, params.id);
  const today = dayKey();
  if (f.cheers.some((c) => c.from === user.id && c.day === today)) throw new HttpError(409, '오늘은 이미 응원을 보냈어요');
  const keepFrom = shiftDay(today, -14);
  f.cheers = f.cheers.filter((c) => c.day >= keepFrom);
  f.cheers.push({ from: user.id, day: today });
  saveDb();
  return { friend: friendSummary(user, f) };
});

/* ------------------------------------------------------------------ */
/* HTTP                                                                 */
/* ------------------------------------------------------------------ */
function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha256(token)] = { userId: user.id, createdAt: Date.now() };
  return token;
}

function authOf(req) {
  const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization || '');
  if (!m) return { user: null, tokenHash: null };
  const tokenHash = sha256(m[1].toLowerCase());
  const session = db.sessions[tokenHash];
  return { user: session ? db.users[session.userId] || null : null, tokenHash };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new HttpError(413, '요청이 너무 커요'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, '요청 형식이 올바르지 않아요'));
      }
    });
    req.on('error', reject);
  });
}

// 로그인·가입 시도 제한: IP마다 10분에 20번 (공개 서버에서 비밀번호 대입 공격을 늦추기 위해)
const authAttempts = new Map();
function limitAuth(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const recent = (authAttempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 20) throw new HttpError(429, '시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요');
  recent.push(now);
  authAttempts.set(ip, recent);
  if (authAttempts.size > 5000) authAttempts.clear();
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.extname(rel) ? null : path.join(PUBLIC_DIR, 'index.html');
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': target.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(req, res, url.pathname);
    return;
  }

  try {
    let params = null;
    const r = routes.find((rt) => {
      if (rt.method !== req.method) return false;
      const m = rt.re.exec(url.pathname);
      if (m) params = m.groups || {};
      return Boolean(m);
    });
    if (!r) throw new HttpError(404, '없는 API예요');
    if (url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/auth/logout') limitAuth(req);
    const { user, tokenHash } = authOf(req);
    if (r.auth && !user) throw new HttpError(401, '로그인이 필요해요');
    const body = req.method === 'GET' ? {} : await readBody(req);
    let data;
    try {
      data = await r.handler({ req, body, user, tokenHash, params });
    } finally {
      await flushDb();
    }
    sendJson(res, 200, data);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    sendJson(res, status, {
      error: status === 500 ? '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요' : err.message,
    });
  }
});

async function start() {
  try {
    await loadDb();
  } catch (err) {
    console.error(`[db] ${err.message}`);
    console.error('[db] SUPABASE_URL, SUPABASE_SERVICE_KEY 값과 app_state 테이블(supabase/schema.sql)을 확인해 주세요.');
    process.exit(1);
  }
  server.listen(PORT, HOST, onListen);
}

function onListen() {
  console.log(`\n  갓생게임 서버가 실행 중이에요 (저장소: ${USE_SUPABASE ? 'Supabase' : DB_FILE})`);
  console.log(`  - 이 컴퓨터에서:          http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  - 같은 와이파이의 휴대폰: http://${n.address}:${PORT}`);
    }
  }
  console.log('  종료하려면 Ctrl + C\n');
}

start();
