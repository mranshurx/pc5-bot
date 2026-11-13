require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Telegraf, Markup } = require('telegraf');

/* ================= CONFIG ================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => Number(s.trim())).filter(Boolean);
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'admin';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const PORT = Number(process.env.PORT || 8080);
const QR_FILE = path.join(__dirname, 'public', 'qr.jpg');
const isAdmin = id => ADMIN_IDS.includes(Number(id));

const QR_TIMEOUT = 12000;
const TG_TIMEOUT = 20000;
const SHOT_TTL = 15 * 60 * 1000;

/* sync tuning */
const SYNC_DEBOUNCE = 4000;        // coalesce bursts of mutations
const SYNC_MIN_INTERVAL = 15000;   // never push faster than this
const SYNC_HEARTBEAT = 10 * 60e3;  // safety push if dirty
const BOOT_PULL_TIMEOUT = 20000;
const PUSH_ATTEMPTS = 3;
const DISK_POLL = 2000;            // re-read state.json written by another process

if (!BOT_TOKEN) { console.error('BOT_TOKEN missing in .env'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

const withTimeout = (promise, ms, label) => {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' timed out')), ms); })
  ]);
};

/* ================= PRICING ================= */
const DEFAULT_PRICING = () => ({
  resellerFee: 15000,
  unlimitedMultiplier: 1.5,
  plans: [
    { id: '1h',  hours: 1,   label: '1 Hour',   retail: 700,   reseller: 500,   on: true },
    { id: '3h',  hours: 3,   label: '3 Hours',  retail: 900,   reseller: 700,   on: true },
    { id: '6h',  hours: 6,   label: '6 Hours',  retail: 1200,  reseller: 900,   on: true },
    { id: '12h', hours: 12,  label: '12 Hours', retail: 1400,  reseller: 1000,  on: true },
    { id: '1d',  hours: 24,  label: '1 Day',    retail: 1900,  reseller: 1400,  on: true },
    { id: '3d',  hours: 72,  label: '3 Days',   retail: 3200,  reseller: 2400,  on: true },
    { id: '7d',  hours: 168, label: '7 Days',   retail: 5500,  reseller: 4200,  on: true },
    { id: '14d', hours: 336, label: '14 Days',  retail: 8200,  reseller: 6200,  on: true },
    { id: '30d', hours: 720, label: '30 Days',  retail: 14900, reseller: 11200, on: true }
  ]
});

const inr = p => { const v = Math.round(Number(p) || 0) / 100; return '₹' + (Number.isInteger(v) ? v : v.toFixed(2)); };
const planById = (pr, id) => (pr.plans || []).find(p => p.id === id);
/* never lose stock to a missing plan row */
const planLoose = id => planById(state.pricing, id) || { id, hours: 0, label: id, retail: 0, reseller: 0, on: true };
const priceFor = (pr, u, plan, dev) => {
  const base = Number(u.tier === 'reseller' ? plan.reseller : plan.retail) || 0;
  const mult = dev === 'unlimited' ? (Number(pr.unlimitedMultiplier) || 1.5) : 1;
  return Math.max(100, Math.ceil(base * mult / 100) * 100);
};

/* ================= STORE ================= */
const FILE = path.join(DATA_DIR, 'state.json');
const BAK = path.join(DATA_DIR, 'state.bak.json');
let state = null;
let queue = Promise.resolve();
let fileMtime = 0;
let writing = false;
let lastReload = 0;

const clone = o => JSON.parse(JSON.stringify(o));

function blank() {
  return {
    rev: 0,
    users: {}, orders: {}, stock: {},
    pricing: DEFAULT_PRICING(),
    settings: {
      upiId: process.env.UPI_ID || '',
      upiName: process.env.UPI_NAME || 'PC5 ANDROID',
      botMaintenance: false,
      maintenanceMsg: 'Bot is under maintenance. Try again shortly.',
      minTopup: 2000, maxTopup: 500000,
      ghAutoSync: true,
      githubToken: process.env.GITHUB_TOKEN || '',
      githubRepo: process.env.GITHUB_REPO || '',
      githubPath: process.env.GITHUB_PATH || 'data/state.json',
      githubBranch: process.env.GITHUB_BRANCH || 'main',
      githubLastSync: '',
      githubLastRev: 0,
      githubLastError: ''
    },
    counters: { nextOrder: 1001 },
    log: []
  };
}

function normalize(raw) {
  const b = blank();
  if (!raw || typeof raw !== 'object') return b;
  const s = { ...b, ...raw };
  for (const k of ['users', 'orders', 'stock']) s[k] = s[k] && typeof s[k] === 'object' ? s[k] : {};
  s.settings = { ...b.settings, ...(s.settings || {}) };
  s.counters = { ...b.counters, ...(s.counters || {}) };
  s.log = Array.isArray(s.log) ? s.log.slice(-500) : [];
  s.rev = Number(s.rev) || 0;
  if (!s.pricing || !Array.isArray(s.pricing.plans)) s.pricing = b.pricing;
  /* repair stock rows so plan/device mismatches can't hide keys */
  for (const [k, v] of Object.entries(s.stock)) {
    if (!v || typeof v !== 'object') { delete s.stock[k]; continue; }
    v.key = k;
    v.planId = String(v.planId || '').trim();
    v.deviceLimit = v.deviceLimit === 'unlimited' ? 'unlimited' : 'single';
    v.status = v.status === 'sold' ? 'sold' : 'available';
  }
  return s;
}

/* unwrap both local state files and github snapshots */
function parseStateText(raw) {
  if (!raw || !raw.trim()) return null;
  const j = JSON.parse(raw);
  const payload = j && j.state && typeof j.state === 'object' ? j.state : j;
  if (!payload || !payload.users) return null;
  return normalize(payload);
}

function writeSync(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const json = JSON.stringify(s, null, 2);
  writing = true;
  try {
    const fd = fs.openSync(FILE + '.tmp', 'w');
    try { fs.writeSync(fd, json); try { fs.fsyncSync(fd); } catch {} } finally { fs.closeSync(fd); }
    fs.renameSync(FILE + '.tmp', FILE);
    try { fs.copyFileSync(FILE, BAK); } catch {}
    fileMtime = fs.statSync(FILE).mtimeMs;
  } finally { writing = false; }
}

function loadState() {
  for (const p of [FILE, BAK]) {
    try {
      if (!fs.existsSync(p)) continue;
      const s = parseStateText(fs.readFileSync(p, 'utf8'));
      if (!s) continue;
      state = s;
      fileMtime = fs.statSync(p).mtimeMs;
      if (p === BAK) { console.warn('primary state unreadable, restored from backup'); writeSync(state); }
      return;
    } catch (e) { console.warn('state unreadable at', path.basename(p), '-', e.message); }
  }
  state = blank();
  writeSync(state);
}

/* adopt a newer file written by another process (panel, second instance) */
function syncFromDisk() {
  if (writing) return;
  try {
    if (!fs.existsSync(FILE)) return;
    const m = fs.statSync(FILE).mtimeMs;
    if (m <= fileMtime) return;
    const s = parseStateText(fs.readFileSync(FILE, 'utf8'));
    if (!s) return;
    fileMtime = m;
    if (s.rev >= state.rev) { state = s; lastReload = Date.now(); }
  } catch {}
}

function log(actor, text) {
  state.log.push({ at: new Date().toISOString(), actor: String(actor), text: String(text).slice(0, 300) });
  if (state.log.length > 500) state.log = state.log.slice(-500);
}

/* queue never stays rejected; quiet = don't mark dirty for sync */
function mutate(fn, opts = {}) {
  const run = queue.then(async () => {
    syncFromDisk();
    const work = clone(state);
    const out = await fn(work);
    work.rev = (work.rev || 0) + 1;
    writeSync(work);
    state = work;
    if (!opts.quiet) markDirty();
    return out;
  });
  queue = run.then(() => {}, () => {});
  return run;
}

function ensureUser(s, from) {
  const id = String(from.id);
  if (!s.users[id]) {
    s.users[id] = {
      id: Number(from.id), username: from.username || '', firstName: from.first_name || '',
      tier: 'normal', credit: 0, banned: false, resellerSince: null,
      createdAt: new Date().toISOString(), totalSpent: 0, keyCount: 0
    };
  } else {
    s.users[id].username = from.username || s.users[id].username;
    s.users[id].firstName = from.first_name || s.users[id].firstName;
  }
  return s.users[id];
}

const availCount = (s, plan, dev) =>
  Object.values(s.stock).filter(k => k.status === 'available' && String(k.planId).trim() === String(plan).trim() && k.deviceLimit === dev).length;

const totalAvailable = s => Object.values(s.stock).filter(k => k.status === 'available').length;

function stockPlanIds() {
  const ids = state.pricing.plans.map(p => p.id);
  for (const k of Object.values(state.stock)) {
    if (k.status === 'available' && !ids.includes(String(k.planId))) ids.push(String(k.planId));
  }
  return ids.filter(Boolean);
}

function claimKey(s, plan, dev, uid, oid) {
  const hit = Object.values(s.stock).find(k => k.status === 'available' && String(k.planId).trim() === String(plan).trim() && k.deviceLimit === dev);
  if (!hit) return null;
  hit.status = 'sold';
  hit.soldAt = new Date().toISOString();
  hit.soldTo = uid;
  hit.orderId = oid;
  return hit;
}

/* ================= GITHUB FULL-STATE SYNC ================= */
/* env wins over panel values, so a token never has to live inside the repo file */
const GH = {
  token: () => (process.env.GITHUB_TOKEN || state.settings.githubToken || '').trim(),
  repo: () => (process.env.GITHUB_REPO || state.settings.githubRepo || '').trim(),
  path: () => (process.env.GITHUB_PATH || state.settings.githubPath || 'data/state.json').trim().replace(/^\/+/, ''),
  branch: () => (process.env.GITHUB_BRANCH || state.settings.githubBranch || 'main').trim() || 'main'
};
const envLocked = k => !!(process.env.GITHUB_TOKEN || (k === 'repo' && process.env.GITHUB_REPO));
const ghReady = () => !!(GH.token() && GH.repo() && GH.path());
const ghAutoOn = () => ghReady() && state.settings.ghAutoSync !== false;

const ghUrl = withRef => {
  const p = GH.path().split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const base = `https://api.github.com/repos/${GH.repo()}/contents/${p}`;
  return withRef ? `${base}?ref=${encodeURIComponent(GH.branch())}` : base;
};

function ghFetch(method, url, body) {
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${GH.token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pc5-bot',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

/* token stripped so the committed file is safe to publish */
function snapshotForRepo(reason) {
  const snap = clone(state);
  delete snap.settings.githubToken;
  return { app: 'pc5-bot', version: 4, rev: snap.rev, savedAt: new Date().toISOString(), reason, state: snap };
}

let dirty = false;
let pushing = false;
let pushTimer = null;
let lastPushAt = 0;
let heartbeat = null;

function markDirty() {
  dirty = true;
  schedulePush();
}

function schedulePush() {
  if (!ghAutoOn()) return;
  clearTimeout(pushTimer);
  const wait = Math.max(SYNC_DEBOUNCE, SYNC_MIN_INTERVAL - (Date.now() - lastPushAt), 0);
  pushTimer = setTimeout(() => { flush().catch(() => {}); }, wait);
}

async function pushState(reason) {
  if (!ghReady()) return { ok: false, error: 'not configured' };
  const snap = snapshotForRepo(reason);
  const body = JSON.stringify(snap, null, 2);
  let lastErr = '';
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    try {
      let sha = null;
      const head = await ghFetch('GET', ghUrl(true));
      if (head.ok) sha = (await head.json()).sha;
      else if (head.status !== 404) throw new Error('read ' + head.status);

      const put = await ghFetch('PUT', ghUrl(false), {
        message: `state sync: ${reason} (rev ${snap.rev})`,
        content: Buffer.from(body).toString('base64'),
        branch: GH.branch(),
        ...(sha ? { sha } : {})
      });
      if (!put.ok) throw new Error('write ' + put.status + ' ' + (await put.text()).slice(0, 120));

      await mutate(x => {
        x.settings.githubLastSync = new Date().toISOString();
        x.settings.githubLastRev = snap.rev;
        x.settings.githubLastError = '';
      }, { quiet: true });
      return { ok: true, rev: snap.rev };
    } catch (e) {
      lastErr = String(e.message || e).slice(0, 200);
      if (attempt < PUSH_ATTEMPTS) await sleep(1200 * attempt);
    }
  }
  await mutate(x => { x.settings.githubLastError = lastErr; }, { quiet: true });
  return { ok: false, error: lastErr };
}

async function flush() {
  if (pushing || !dirty) return;
  if (!ghAutoOn()) { dirty = false; return; }
  pushing = true;
  dirty = false;
  try { await pushState('auto'); }
  finally {
    pushing = false;
    lastPushAt = Date.now();
    if (dirty) schedulePush();
  }
}

async function forceFlush() {
  dirty = true;
  for (let i = 0; i < 40 && pushing; i++) await sleep(250);
  await flush();
}

async function pullState() {
  if (!ghReady()) throw new Error('not configured');
  const r = await ghFetch('GET', ghUrl(true));
  if (r.status === 404) return { imported: false, legacy: 0 };

  if (!r.ok) throw new Error('read ' + r.status);
  const j = await r.json();
  let data;
  try { data = JSON.parse(Buffer.from(j.content || '', 'base64').toString('utf8')); }
  catch { throw new Error('remote file is not valid json'); }

  const payload = data && data.state && typeof data.state === 'object' ? data.state : data;

  if (payload && payload.users && payload.orders) {
    await mutate(s => {
      const token = s.settings.githubToken;
      Object.keys(s).forEach(k => delete s[k]);
      Object.assign(s, normalize(payload));
      if (!s.settings.githubToken && token) s.settings.githubToken = token;
      log('github', `pulled state rev ${s.rev || 0}`);
    }, { quiet: true });
    return { imported: true, legacy: 0 };
  }

  if (payload && payload.stock) {
    const n = await mutate(s => {
      let added = 0;
      for (const [k, v] of Object.entries(payload.stock)) {
        if (s.stock[k] || !v || !v.planId) continue;
        s.stock[k] = {
          key: k, planId: v.planId,
          deviceLimit: v.deviceLimit === 'unlimited' ? 'unlimited' : 'single',
          status: v.status === 'sold' ? 'sold' : 'available',
          addedAt: new Date().toISOString(), soldAt: v.soldAt || null,
          soldTo: v.soldTo || null, orderId: v.orderId || null
        };
        added++;
      }
      log('github', `legacy import ${added}`);
      return added;
    }, { quiet: true });
    return { imported: false, legacy: n };
  }

  throw new Error('remote file has no usable data');
}

/* ================= BOT ================= */
const bot = new Telegraf(BOT_TOKEN);
try { bot.telegram.options.timeout = TG_TIMEOUT; } catch {}

const pending = new Map();

const BTN = { buy: '🛒 Buy Key', credit: '➕ Add Credit', balance: '💰 Balance', mykeys: '🔑 My Keys', reseller: '🏪 Reseller', help: '❓ Help' };
const menu = () => Markup.keyboard([[BTN.buy, BTN.credit], [BTN.balance, BTN.mykeys], [BTN.reseller, BTN.help]]).resize();

const PAY_MSG = 'PAY THE SELECTED AMOUNT AND UPLOAD THE PAYMENT SCREENSHOT, PAY IN THE QR THAT IS IN THE BOT PROFILE PICTURE';

async function notifyAdmins(text, opts = {}) {
  for (const a of ADMIN_IDS) bot.telegram.sendMessage(a, text, opts).catch(() => {});
}

function setPending(uid, data) {
  pending.set(uid, { ...data, at: Date.now() });
}

function getPending(uid) {
  const p = pending.get(uid);
  if (!p) return null;
  if (Date.now() - p.at > SHOT_TTL) { pending.delete(uid); return null; }
  return p;
}

async function sendPaymentQr(ctx, amount, orderId) {
  const caption = `Scan & pay *${inr(amount)}* · Order #${orderId}`;
  const opts = { caption, parse_mode: 'Markdown' };
  const note = `PC5-${orderId}`;

  if (fs.existsSync(QR_FILE)) {
    try {
      return await withTimeout(
        ctx.replyWithPhoto({ source: fs.createReadStream(QR_FILE) }, opts),
        QR_TIMEOUT, 'qr.jpg'
      );
    } catch (e) { console.warn('qr.jpg send failed:', e.message); }
  }

  if (state.settings.upiId && state.settings.upiId !== 'PUT-YOUR-UPI-HERE') {
    try {
      const upi = `upi://pay?pa=${encodeURIComponent(state.settings.upiId)}&pn=${encodeURIComponent(state.settings.upiName)}&am=${(amount / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;
      const png = await QRCode.toBuffer(upi, { width: 640, margin: 1 });
      return await withTimeout(ctx.replyWithPhoto({ source: png }, opts), QR_TIMEOUT, 'upi qr');
    } catch (e) { console.warn('generated qr send failed:', e.message); }
  }

  return null;
}

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  syncFromDisk();
  const u = state.users[String(ctx.from.id)];
  if (u && u.banned && !isAdmin(ctx.from.id)) return ctx.reply('🚫 Banned. Contact support.');
  if (state.settings.botMaintenance && !isAdmin(ctx.from.id) && ctx.message && !ctx.message.text?.startsWith('/start')) {
    return ctx.reply(`🛠 ${state.settings.maintenanceMsg}`);
  }
  return next();
});

bot.start(async ctx => {
  const u = await mutate(s => ensureUser(s, ctx.from));
  await ctx.reply(`👋 Welcome${u.firstName ? ', ' + u.firstName : ''}.\n\nTier: ${u.tier.toUpperCase()}\nBalance: ${inr(u.credit)}\n\nAdd credit, then buy a key.`, menu());
});

bot.help(async ctx => ctx.reply(
  `*How it works*\n\n1. Add Credit — pick amount, pay the QR, send screenshot.\n2. We verify and credit you manually.\n3. Buy Key — pick plan and device limit.\n\n*Reseller* — pay ${inr(state.pricing.resellerFee)} once, then every key is at reseller rate.`,
  { parse_mode: 'Markdown', ...menu() }
));

bot.hears(BTN.balance, async ctx => {
  syncFromDisk();
  const u = state.users[String(ctx.from.id)];
  if (!u) return ctx.reply('/start first');
  await ctx.reply(`💰 Balance: *${inr(u.credit)}*\nTier: ${u.tier.toUpperCase()}\nKeys: ${u.keyCount}\nSpent: ${inr(u.totalSpent)}`, { parse_mode: 'Markdown' });
});

bot.hears(BTN.mykeys, async ctx => {
  syncFromDisk();
  const mine = Object.values(state.orders)
    .filter(o => o.type === 'key' && o.userId === Number(ctx.from.id) && o.key)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 15);
  if (!mine.length) return ctx.reply('No keys yet.');
  await ctx.reply('*Your keys*\n\n' + mine.map(o => {
    const p = planById(state.pricing, o.planId);
    return `\`${o.key}\` — ${p ? p.label : o.hours + 'h'} · ${o.deviceLimit}`;
  }).join('\n'), { parse_mode: 'Markdown' });
});

/* ---- credit ---- */
const TOPUPS = [5000, 10000, 20000, 50000, 100000];

bot.hears(BTN.credit, async ctx => {
  syncFromDisk();
  const rows = [];
  for (let i = 0; i < TOPUPS.length; i += 2) rows.push(TOPUPS.slice(i, i + 2).map(a => Markup.button.callback(inr(a), `tup:${a}`)));
  rows.push([Markup.button.callback('✏️ Custom', 'tup:custom')]);
  await ctx.reply(`➕ *Add Credit*\nMin ${inr(state.settings.minTopup)} · Max ${inr(state.settings.maxTopup)}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
});

async function makeTopup(ctx, amount) {
  const out = await mutate(s => {
    const u = ensureUser(s, ctx.from);
    if (amount < s.settings.minTopup || amount > s.settings.maxTopup)
      throw new Error(`Amount must be ${inr(s.settings.minTopup)}–${inr(s.settings.maxTopup)}`);
    const id = String(s.counters.nextOrder++);
    s.orders[id] = {
      id, userId: u.id, username: u.username, type: 'topup', amount,
      status: 'awaiting_payment', screenshotFileId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), note: ''
    };
    log(u.id, `topup ${id} ${inr(amount)}`);
    return { order: s.orders[id], upiId: s.settings.upiId };
  });

  setPending(ctx.from.id, { action: 'shot', orderId: out.order.id });

  const caption =
    `*Order #${out.order.id}* · *${inr(amount)}*\n\n` +
    `${PAY_MSG}\n\n` +
    (out.upiId && out.upiId !== 'PUT-YOUR-UPI-HERE' ? `UPI: \`${out.upiId}\`\n` : '') +
    `Order note: \`PC5-${out.order.id}\``;

  await ctx.reply(caption, { parse_mode: 'Markdown' });
  sendPaymentQr(ctx, amount, out.order.id).catch(() => {});
}

bot.action(/^tup:(\d+)$/, async ctx => {
  await ctx.answerCbQuery().catch(() => {});
  try { await makeTopup(ctx, Number(ctx.match[1])); }
  catch (e) { ctx.reply(e.message || 'Could not start order.').catch(() => {}); }
});

bot.action('tup:custom', async ctx => {
  await ctx.answerCbQuery().catch(() => {});
  setPending(ctx.from.id, { action: 'amount' });
  await ctx.reply(`Send the rupee amount (${inr(state.settings.minTopup)}–${inr(state.settings.maxTopup)}):`);
});

/* ---- screenshot ---- */
bot.on(['photo', 'document'], async ctx => {
  syncFromDisk();
  const st = getPending(ctx.from.id);

  const isImageDoc = !ctx.message.document || /^image\//.test(ctx.message.document.mime_type || '');
  if (ctx.message.document && !isImageDoc) return ctx.reply('Send an image (screenshot), not a file.');

  let order = st && st.action === 'shot' ? state.orders[st.orderId] : null;

  if (!order || order.status !== 'awaiting_payment') {
    order = Object.values(state.orders)
      .filter(o => o.userId === Number(ctx.from.id) && o.type !== 'key' && o.status === 'awaiting_payment')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
  if (!order) return ctx.reply('No open order. Press ➕ Add Credit.');

  const fileId = ctx.message.photo ? ctx.message.photo.at(-1).file_id : ctx.message.document.file_id;

  await mutate(s => {
    const o = s.orders[order.id];
    o.screenshotFileId = fileId;
    o.status = 'pending_review';
    o.updatedAt = new Date().toISOString();
    log(ctx.from.id, `order ${order.id} proof`);
  });
  pending.delete(ctx.from.id);

  await ctx.reply(`✅ Proof received for #${order.id}. Waiting for approval.`);

  const cap = `💳 *${order.type === 'reseller' ? 'Reseller' : 'Top-up'} #${order.id}*\nUser: ${order.userId}\nAmount: *${inr(order.amount)}*`;
  const kb = Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `ord:ok:${order.id}`), Markup.button.callback('❌ Reject', `ord:no:${order.id}`)]]).reply_markup;
  for (const a of ADMIN_IDS) {
    try { await bot.telegram.sendPhoto(a, fileId, { caption: cap, parse_mode: 'Markdown', reply_markup: kb }); }
    catch { try { await bot.telegram.sendDocument(a, fileId, { caption: cap, parse_mode: 'Markdown', reply_markup: kb }); } catch {} }
  }
});

bot.action(/^ord:ok:(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
  const id = ctx.match[1];
  const res = await mutate(s => {
    const o = s.orders[id];
    if (!o || o.status === 'approved') return null;
    o.status = 'approved';
    o.updatedAt = new Date().toISOString();
    const u = s.users[String(o.userId)];
    if (o.type === 'topup' && u) u.credit += o.amount;
    if (o.type === 'reseller' && u) { u.tier = 'reseller'; u.resellerSince = new Date().toISOString(); }
    log(ctx.from.id, `order ${id} approved`);
    return { o, bal: u ? u.credit : 0 };
  });
  await ctx.answerCbQuery(res ? 'Approved' : 'Already done');
  if (!res) return;
  ctx.editMessageCaption(`${ctx.callbackQuery.message.caption}\n\n✅ Approved`, { parse_mode: 'Markdown' }).catch(() => {});
  bot.telegram.sendMessage(res.o.userId, res.o.type === 'reseller'
    ? '✅ Reseller approved.'
    : `✅ ${inr(res.o.amount)} added. Balance ${inr(res.bal)}`).catch(() => {});
});

bot.action(/^ord:no:(.+)$/, async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Admins only');
  setPending(ctx.from.id, { action: 'reason', orderId: ctx.match[1] });
  await ctx.answerCbQuery();
  await ctx.reply(`Reason for #${ctx.match[1]}? ("-" to skip)`);
});

/* ---- buy ---- */
function buyKb(u) {
  const build = respectOn => {
    const rows = [];
    for (const id of stockPlanIds()) {
      const p = planLoose(id);
      if (respectOn && p.on === false) continue;
      const single = availCount(state, id, 'single');
      const unl = availCount(state, id, 'unlimited');
      if (!single && !unl) continue;
      const cheapest = Math.min(
        single ? priceFor(state.pricing, u, p, 'single') : Infinity,
        unl ? priceFor(state.pricing, u, p, 'unlimited') : Infinity
      );
      rows.push([Markup.button.callback(`${p.label} — ${inr(cheapest)}`, `plan:${id}`)]);
    }
    return rows;
  };
  let rows = build(true);
  if (!rows.length) rows = build(false);
  return Markup.inlineKeyboard(rows);
}

bot.hears(BTN.buy, async ctx => {
  syncFromDisk();
  const u = state.users[String(ctx.from.id)];
  if (!u) return ctx.reply('/start first');
  const kb = buyKb(u);
  if (!kb.reply_markup.inline_keyboard.length) return ctx.reply('📦 Out of stock.');
  await ctx.reply(`🛒 *Buy a Key*\nBalance: ${inr(u.credit)}`, { parse_mode: 'Markdown', ...kb });
});

bot.action(/^plan:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  syncFromDisk();
  const u = state.users[String(ctx.from.id)];
  const p = planById(state.pricing, ctx.match[1]) || planLoose(ctx.match[1]);
  if (!p || !u) return ctx.reply('Use /start first.');
  const rows = [];
  if (availCount(state, p.id, 'single')) rows.push([Markup.button.callback(`1 Device — ${inr(priceFor(state.pricing, u, p, 'single'))}`, `dev:${p.id}:single`)]);
  if (availCount(state, p.id, 'unlimited')) rows.push([Markup.button.callback(`Unlimited — ${inr(priceFor(state.pricing, u, p, 'unlimited'))}`, `dev:${p.id}:unlimited`)]);
  rows.push([Markup.button.callback('‹ Back', 'home')]);
  await ctx.editMessageText(`*${p.label}* — choose device limit`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
});

bot.action('home', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText('Use the menu.', menu()); });

bot.action(/^dev:(.+):(single|unlimited)$/, async ctx => {
  await ctx.answerCbQuery();
  syncFromDisk();
  const u = state.users[String(ctx.from.id)];
  const p = planById(state.pricing, ctx.match[1]) || planLoose(ctx.match[1]);
  const dev = ctx.match[2];
  if (!p || !u) return;
  const price = priceFor(state.pricing, u, p, dev);
  await ctx.editMessageText(
    `*Confirm*\n${p.label} · ${dev}\nPrice *${inr(price)}*\nBalance ${inr(u.credit)}` + (u.credit < price ? `\n\n⚠️ Short ${inr(price - u.credit)}` : ''),
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`✅ Pay ${inr(price)}`, `pay:${p.id}:${dev}`)], [Markup.button.callback('‹ Back', `plan:${p.id}`)]]) }
  );
});

bot.action(/^pay:(.+):(single|unlimited)$/, async ctx => {
  const planId = ctx.match[1], dev = ctx.match[2];
  syncFromDisk();
  const u0 = state.users[String(ctx.from.id)];
  const p0 = planById(state.pricing, planId) || planLoose(planId);
  if (!p0 || !u0) return ctx.answerCbQuery('Gone');
  if (u0.credit < priceFor(state.pricing, u0, p0, dev)) return ctx.answerCbQuery('Not enough balance', { show_alert: true });

  let out;
  try {
    out = await mutate(s => {
      const u = s.users[String(ctx.from.id)];
      const p = planById(s.pricing, planId) || planLoose(planId);
      const cost = priceFor(s.pricing, u, p, dev);
      if (u.credit < cost) throw new Error('funds');
      const id = String(s.counters.nextOrder++);
      const hit = claimKey(s, planId, dev, u.id, id);
      if (!hit) throw new Error('stock');
      u.credit -= cost; u.totalSpent += cost; u.keyCount += 1;
      s.orders[id] = {
        id, userId: u.id, username: u.username, type: 'key', planId, hours: p.hours,
        deviceLimit: dev, amount: cost, status: 'completed', key: hit.key,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      log(u.id, `sold ${hit.key}`);
      return { key: hit.key, bal: u.credit, cost };
    });
  } catch (e) {
    return ctx.answerCbQuery(e.message === 'stock' ? 'Sold out' : 'Failed', { show_alert: true });
  }

  await ctx.answerCbQuery('Delivered');
  await ctx.editMessageText(`✅ *Key*\n\n\`${out.key}\`\n${p0.label} · ${dev}\nCharged ${inr(out.cost)}\nBalance ${inr(out.bal)}`, { parse_mode: 'Markdown' });
  notifyAdmins(`🔑 ${out.key} → ${ctx.from.id} (${p0.label}, ${inr(out.cost)})`);
});

/* ---- reseller ---- */
bot.hears(BTN.reseller, async ctx => {
  syncFromDisk();
  const u = state.users[String(ctx.from.id)];
  if (!u) return ctx.reply('/start first');
  if (u.tier === 'reseller') return ctx.reply('🏪 Already a reseller.');
  const fee = inr(state.pricing.resellerFee);
  const sample = state.pricing.plans.filter(p => p.on).slice(0, 3).map(p => `• ${p.label}: ${inr(p.retail)} → *${inr(p.reseller)}*`).join('\n');
  await ctx.reply(`🏪 *Reseller Pack*\nOne-time *${fee}*\n\n${sample}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`Pay ${fee}`, 'rsl')]]) });
});

bot.action('rsl', async ctx => {
  await ctx.answerCbQuery();
  syncFromDisk();
  const u = state.users[String(ctx.from.id)];
  if (!u) return ctx.reply('/start first');
  if (u.tier === 'reseller') return ctx.reply('Already a reseller.');
  if (Object.values(state.orders).some(o => o.type === 'reseller' && o.userId === u.id && o.status === 'awaiting_payment'))
    return ctx.reply('You already have a reseller order open.');

  const fee = state.pricing.resellerFee;
  const order = await mutate(s => {
    const id = String(s.counters.nextOrder++);
    s.orders[id] = { id, userId: u.id, username: u.username, type: 'reseller', amount: fee, status: 'awaiting_payment', screenshotFileId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    log(u.id, `reseller ${id}`);
    return s.orders[id];
  });

  setPending(ctx.from.id, { action: 'shot', orderId: order.id });

  const caption =
    `*Reseller #${order.id}* · *${inr(fee)}*\n\n` +
    `${PAY_MSG}\n\n` +
    (state.settings.upiId && state.settings.upiId !== 'PUT-YOUR-UPI-HERE' ? `UPI: \`${state.settings.upiId}\`\n` : '') +
    `Order note: \`PC5RSL-${order.id}\``;

  await ctx.reply(caption, { parse_mode: 'Markdown' });
  sendPaymentQr(ctx, fee, order.id).catch(() => {});
});

/* ---- text states ---- */
bot.on('text', async ctx => {
  const st = getPending(ctx.from.id);
  if (!st) return;

  if (st.action === 'amount') {
    const r = Number(ctx.message.text.replace(/[^\d.]/g, ''));
    if (!r) return ctx.reply('Send a number.');
    pending.delete(ctx.from.id);
    try { await makeTopup(ctx, Math.round(r * 100)); }
    catch (e) { ctx.reply(e.message || 'Failed.').catch(() => {}); }
    return;
  }
  if (st.action === 'reason' && isAdmin(ctx.from.id)) {
    const reason = ctx.message.text.trim() === '-' ? '' : ctx.message.text.trim();
    pending.delete(ctx.from.id);
    const o = await mutate(s => {
      const ord = s.orders[st.orderId];
      if (!ord) return null;
      ord.status = 'rejected'; ord.note = reason;
      log(ctx.from.id, `order ${ord.id} rejected`);
      return ord;
    });
    if (!o) return ctx.reply('Not found');
    await ctx.reply(`Rejected #${o.id}`);
    bot.telegram.sendMessage(o.userId, `❌ #${o.id} rejected${reason ? ':\n' + reason : ''}`).catch(() => {});
  }
});

/* ---- admin commands ---- */
bot.command('stats', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  syncFromDisk();
  const us = Object.values(state.users);
  await ctx.reply(`${us.length} users · ${us.filter(u => u.tier === 'reseller').length} resellers\n` +
    `${totalAvailable(state)} in stock\n` +
    `${inr(us.reduce((a, u) => a + u.credit, 0))} credit held\n` +
    `sync: ${ghReady() ? (state.settings.githubLastError ? 'error' : 'ok') : 'off'} · rev ${state.rev}`);
});
bot.command('stock', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  syncFromDisk();
  await ctx.reply(state.pricing.plans.map(p => `${p.label}: ${availCount(state, p.id, 'single')} single / ${availCount(state, p.id, 'unlimited')} unl`).join('\n') +
    `\n\ntotal available: ${totalAvailable(state)}`);
});
bot.command('sync', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  if (!ghReady()) return ctx.reply('Sync not configured.');
  const r = await pushState('manual');
  await ctx.reply(r.ok ? `✅ Pushed rev ${r.rev}` : '❌ ' + r.error);
});
bot.command('pull', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  try { const r = await pullState(); await ctx.reply(`✅ Pulled. imported=${r.imported} legacy=${r.legacy}`); }
  catch (e) { await ctx.reply('❌ ' + e.message); }
});
bot.command('addcredit', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const [, id, r] = ctx.message.text.split(/\s+/);
  if (!id || !r) return ctx.reply('/addcredit <id> <rupees>');
  const bal = await mutate(s => { const u = s.users[id]; if (!u) return null; u.credit += Math.round(Number(r) * 100); return u.credit; });
  if (bal === null) return ctx.reply('No user');
  await ctx.reply(`Balance ${inr(bal)}`);
  bot.telegram.sendMessage(id, `💰 ${inr(Number(r) * 100)} added`).catch(() => {});
});
bot.command('setreseller', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const [, id, m] = ctx.message.text.split(/\s+/);
  const t = await mutate(s => { const u = s.users[id]; if (!u) return null; u.tier = m === 'off' ? 'normal' : 'reseller'; u.resellerSince = u.tier === 'reseller' ? new Date().toISOString() : null; return u.tier; });
  await ctx.reply(t ? `${id} → ${t}` : 'No user');
});
bot.command('ban', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const [, id] = ctx.message.text.split(/\s+/);
  const b = await mutate(s => { const u = s.users[id]; if (!u) return null; u.banned = !u.banned; return u.banned; });
  await ctx.reply(b === null ? 'No user' : `${id} banned=${b}`);
});
bot.command('broadcast', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  const text = ctx.message.text.replace(/^\/broadcast\s*/, '').trim();
  if (!text) return ctx.reply('/broadcast <msg>');
  let ok = 0, fail = 0;
  for (const u of Object.values(state.users)) {
    try { await bot.telegram.sendMessage(u.id, text); ok++; } catch { fail++; }
    await new Promise(r => setTimeout(r, 40));
  }
  await ctx.reply(`Sent ${ok}, failed ${fail}`);
});
bot.catch((e, ctx) => { console.error('[bot]', e.message); ctx.reply('Error.').catch(() => {}); });

/* ================= WEB PANEL ================= */
const app = express();
app.use(express.json({ limit: '12mb' }));

const sessions = new Map();
const shots = new Map();
const eq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const jar = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(p => {
  const i = p.indexOf('='); return i > 0 ? [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())] : null;
}).filter(Boolean));

const loginHits = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const rec = loginHits.get(ip) || { n: 0, at: now };
  if (now - rec.at > 10 * 60e3) { rec.n = 0; rec.at = now; }
  rec.n++;
  loginHits.set(ip, rec);
  return rec.n <= 12;
}

function guard(req, res, next) {
  const t = jar(req).sid;
  if (!t || !sessions.get(t) || sessions.get(t) < Date.now()) return res.status(401).json({ error: 'unauthorized' });
  if (req.method === 'POST' && req.headers['x-panel'] !== '1') return res.status(401).json({ error: 'header' });
  next();
}

app.post('/api/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'x';
  if (!loginAllowed(ip)) return res.status(429).json({ error: 'too many attempts, wait 10 min' });
  if (!eq((req.body || {}).password || '', PANEL_PASSWORD)) return res.status(401).json({ error: 'wrong password' });
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, Date.now() + 8 * 3600e3);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.post('/api/logout', guard, (req, res) => {
  sessions.delete(jar(req).sid);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

const maskToken = t => (t ? t.slice(0, 6) + '…' + t.slice(-4) : '');

app.get('/api/state', guard, (req, res) => {
  syncFromDisk();
  const st = Object.values(state.stock);
  const summary = {};
  for (const p of state.pricing.plans) summary[p.id] = {
    single: st.filter(k => k.status === 'available' && k.planId === p.id && k.deviceLimit === 'single').length,
    unlimited: st.filter(k => k.status === 'available' && k.planId === p.id && k.deviceLimit === 'unlimited').length
  };
  for (const k of st) {
    if (k.status !== 'available' || summary[k.planId]) continue;
    summary[k.planId] = {
      single: st.filter(x => x.status === 'available' && x.planId === k.planId && x.deviceLimit === 'single').length,
      unlimited: st.filter(x => x.status === 'available' && x.planId === k.planId && x.deviceLimit === 'unlimited').length
    };
  }
  const s = state.settings;
  res.json({
    stats: {
      users: Object.keys(state.users).length,
      resellers: Object.values(state.users).filter(u => u.tier === 'reseller').length,
      creditHeld: Object.values(state.users).reduce((a, u) => a + u.credit, 0),
      pending: Object.values(state.orders).filter(o => o.status === 'pending_review').length,
      sold: Object.values(state.orders).filter(o => o.type === 'key').length,
      available: st.filter(k => k.status === 'available').length,
      rev: state.rev,
      dirty: dirty ? 1 : 0
    },
    users: Object.values(state.users).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    orders: Object.values(state.orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200),
    stockSummary: summary,
    stockTotal: st.filter(k => k.status === 'available').length,
    stock: st.filter(k => k.status === 'available').slice(0, 400),
    pricing: state.pricing,
    settings: {
      upiId: s.upiId, upiName: s.upiName, botMaintenance: s.botMaintenance,
      maintenanceMsg: s.maintenanceMsg, minTopup: s.minTopup, maxTopup: s.maxTopup
    },
    github: {
      repo: GH.repo(), path: GH.path(), branch: GH.branch(),
      hasToken: !!GH.token(), tokenHint: maskToken(GH.token()),
      tokenLocked: !!process.env.GITHUB_TOKEN, repoLocked: !!process.env.GITHUB_REPO,
      ready: ghReady(), auto: s.ghAutoSync !== false,
      lastSync: s.githubLastSync, lastRev: s.githubLastRev, lastError: s.githubLastError
    },
    qrExists: fs.existsSync(QR_FILE),
    disk: { file: path.basename(FILE), bytes: fs.existsSync(FILE) ? fs.statSync(FILE).size : 0, lastReload },
    log: state.log.slice(-80).reverse()
  });
});

app.get('/api/qr', (req, res) => {
  if (!fs.existsSync(QR_FILE)) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(QR_FILE);
});

app.post('/api/qr', guard, async (req, res) => {
  const d = String((req.body || {}).dataUrl || '');
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(d);
  if (!m) return res.status(400).json({ error: 'unsupported image' });
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty image' });
  if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'too large (max 8MB)' });
  fs.mkdirSync(path.dirname(QR_FILE), { recursive: true });
  fs.writeFileSync(QR_FILE, buf);
  await mutate(s => log('panel', 'qr updated'));
  res.json({ ok: true, bytes: buf.length });
});

app.post('/api/github', guard, async (req, res) => {
  const b = req.body || {};
  await mutate(s => {
    if (typeof b.token === 'string' && b.token.trim()) s.settings.githubToken = b.token.trim();
    if (b.clearToken) s.settings.githubToken = '';
    if (b.repo != null) s.settings.githubRepo = String(b.repo).trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    if (b.path != null) s.settings.githubPath = String(b.path).trim().replace(/^\/+/, '') || 'data/state.json';
    if (b.branch != null) s.settings.githubBranch = String(b.branch).trim() || 'main';
    if (b.auto != null) s.settings.ghAutoSync = !!b.auto;
    s.settings.githubLastError = '';
    log('panel', 'sync config');
  });
  if (ghReady() && state.settings.ghAutoSync) schedulePush();
  res.json({ ok: true });
});

app.post('/api/github/push', guard, async (req, res) => {
  const r = await pushState('panel');
  r.ok ? res.json(r) : res.status(400).json(r);
});

app.post('/api/github/pull', guard, async (req, res) => {
  try { res.json({ ok: true, ...(await pullState()) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.post('/api/user/:id', guard, async (req, res) => {
  const { creditDelta, tier, banned } = req.body || {};
  const u = await mutate(s => {
    const x = s.users[req.params.id];
    if (!x) return null;
    if (creditDelta != null) x.credit = Math.max(0, x.credit + Math.round(Number(creditDelta) * 100));
    if (tier) { x.tier = tier === 'reseller' ? 'reseller' : 'normal'; x.resellerSince = x.tier === 'reseller' ? new Date().toISOString() : null; }
    if (banned != null) x.banned = !!banned;
    log('panel', `user ${x.id}`);
    return x;
  });
  u ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
});

app.post('/api/order/:id/:action', guard, async (req, res) => {
  const { id, action } = req.params;
  const reason = String((req.body || {}).reason || '');
  const out = await mutate(s => {
    const o = s.orders[id];
    if (!o) return null;
    if (action === 'approve') {
      if (o.status === 'approved') return { o, bal: null };
      o.status = 'approved';
      const u = s.users[String(o.userId)];
      if (o.type === 'topup' && u) u.credit += o.amount;
      if (o.type === 'reseller' && u) { u.tier = 'reseller'; u.resellerSince = new Date().toISOString(); }
      log('panel', `order ${id} approved`);
      return { o, bal: u ? u.credit : null };
    }
    o.status = 'rejected'; o.note = reason;
    log('panel', `order ${id} rejected`);
    return { o, bal: null };
  });
  if (!out) return res.status(404).json({ error: 'not found' });
  bot.telegram.sendMessage(out.o.userId, action === 'approve'
    ? (out.o.type === 'reseller' ? '✅ Reseller approved.' : `✅ ${inr(out.o.amount)} added${out.bal != null ? '. Balance ' + inr(out.bal) : ''}`)
    : `❌ #${out.o.id} rejected${reason ? ':\n' + reason : ''}`).catch(() => {});
  res.json({ ok: true });
});

/* resolve a plan id even when the row is gone, so adds never bounce */
function resolvePlanId(raw) {
  const id = String(raw || '').trim();
  if (id && (planById(state.pricing, id) || Object.values(state.stock).some(k => k.planId === id))) return id;
  const first = state.pricing.plans.find(p => p.on !== false) || state.pricing.plans[0];
  return first ? first.id : '1h';
}

app.post('/api/stock/add', guard, async (req, res) => {
  syncFromDisk();
  const planId = resolvePlanId((req.body || {}).planId);
  const dev = (req.body || {}).deviceLimit === 'unlimited' ? 'unlimited' : 'single';
  const keys = String((req.body || {}).text || '').split(/[\s,;]+/).map(k => k.trim().toUpperCase()).filter(Boolean);
  if (!keys.length) return res.status(400).json({ error: 'no keys' });

  const out = await mutate(s => {
    let added = 0, dupes = 0;
    for (const k of keys) {
      if (s.stock[k]) { dupes++; continue; }
      s.stock[k] = { key: k, planId, deviceLimit: dev, status: 'available', addedAt: new Date().toISOString(), soldAt: null, soldTo: null, orderId: null };
      added++;
    }
    log('panel', `stock +${added} (${planId}/${dev})`);
    return { added, dupes, planId, total: Object.values(s.stock).filter(x => x.status === 'available').length };
  });
  res.json({ ok: true, ...out });
});

app.post('/api/stock/gen', guard, async (req, res) => {
  syncFromDisk();
  const planId = resolvePlanId((req.body || {}).planId);
  const dev = (req.body || {}).deviceLimit === 'unlimited' ? 'unlimited' : 'single';
  const n = Math.min(Math.max(Number((req.body || {}).count) || 1, 1), 500);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const added = await mutate(s => {
    let made = 0;
    for (let i = 0; i < n; i++) {
      let k;
      do { k = 'PC5-' + Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (s.stock[k]);
      s.stock[k] = { key: k, planId, deviceLimit: dev, status: 'available', addedAt: new Date().toISOString(), soldAt: null, soldTo: null, orderId: null };
      made++;
    }
    log('panel', `stock gen +${made} (${planId}/${dev})`);
    return made;
  });
  res.json({ ok: true, added, planId });
});

app.post('/api/stock/remove', guard, async (req, res) => {
  syncFromDisk();
  const keys = Array.isArray((req.body || {}).keys) ? req.body.keys : [];
  const removed = await mutate(s => {
    let n = 0;
    for (const k of keys) if (s.stock[k] && s.stock[k].status === 'available') { delete s.stock[k]; n++; }
    log('panel', `stock -${n}`);
    return n;
  });
  res.json({ ok: true, removed });
});

app.post('/api/pricing', guard, async (req, res) => {
  const { plans, resellerFee, unlimitedMultiplier } = req.body || {};
  await mutate(s => {
    if (Array.isArray(plans)) s.pricing.plans = plans.map(p => ({
      id: String(p.id), hours: Number(p.hours), label: String(p.label).slice(0, 30),
      retail: Math.round(Number(p.retail) * 100), reseller: Math.round(Number(p.reseller) * 100), on: !!p.on
    }));
    if (resellerFee != null) s.pricing.resellerFee = Math.round(Number(resellerFee) * 100);
    if (unlimitedMultiplier != null) s.pricing.unlimitedMultiplier = Number(unlimitedMultiplier);
    log('panel', 'pricing');
  });
  res.json({ ok: true });
});

app.post('/api/settings', guard, async (req, res) => {
  const b = req.body || {};
  await mutate(s => {
    if (b.upiId != null) s.settings.upiId = String(b.upiId).slice(0, 80);
    if (b.upiName != null) s.settings.upiName = String(b.upiName).slice(0, 80);
    if (b.botMaintenance != null) s.settings.botMaintenance = !!b.botMaintenance;
    if (b.maintenanceMsg != null) s.settings.maintenanceMsg = String(b.maintenanceMsg).slice(0, 300);
    if (b.minTopup != null) s.settings.minTopup = Math.round(Number(b.minTopup) * 100);
    if (b.maxTopup != null) s.settings.maxTopup = Math.round(Number(b.maxTopup) * 100);
    log('panel', 'settings');
  });
  res.json({ ok: true });
});

app.get('/api/backup', guard, (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="pc5-${Date.now()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  const snap = clone(state);
  delete snap.settings.githubToken;
  res.send(JSON.stringify(snap, null, 2));
});

app.post('/api/restore', guard, async (req, res) => {
  await mutate(s => {
    const token = s.settings.githubToken;
    const repo = s.settings.githubRepo;
    const p = s.settings.githubPath;
    const br = s.settings.githubBranch;
    Object.keys(s).forEach(k => delete s[k]);
    Object.assign(s, normalize(req.body));
    s.settings.githubToken = s.settings.githubToken || token;
    s.settings.githubRepo = s.settings.githubRepo || repo;
    s.settings.githubPath = s.settings.githubPath || p;
    s.settings.githubBranch = s.settings.githubBranch || br;
  });
  if (ghReady()) schedulePush();
  res.json({ ok: true });
});

app.post('/api/genkey', guard, async (req, res) => {
  syncFromDisk();
  const { userId, deviceLimit } = req.body || {};
  const planId = resolvePlanId((req.body || {}).planId);
  const u = state.users[String(userId)];
  const p = planById(state.pricing, planId) || planLoose(planId);
  if (!u || !p) return res.status(400).json({ error: 'bad input' });
  const dev = deviceLimit === 'unlimited' ? 'unlimited' : 'single';

  const key = await mutate(s => {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let k;
    do { k = 'PC5-' + Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (s.stock[k]);
    const id = String(s.counters.nextOrder++);
    s.orders[id] = { id, userId: u.id, type: 'key', planId, hours: p.hours, deviceLimit: dev, amount: 0, status: 'granted', key: k, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    s.users[String(u.id)].keyCount += 1;
    log('panel', `granted ${k}`);
    return k;
  });
  bot.telegram.sendMessage(u.id, `🎁 Admin issued:\n\`${key}\`\n${p.label}`, { parse_mode: 'Markdown' }).catch(() => {});
  res.json({ ok: true, key });
});

async function sendShot(res, fileId) {
  if (!fileId) return res.status(404).json({ error: 'no proof on this order' });
  try {
    let fp = shots.get(fileId);
    if (!fp) {
      const j = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`)).json();
      if (!j.ok) return res.status(404).json({ error: 'telegram: ' + (j.description || 'file gone') });
      fp = j.result.file_path;
      shots.set(fileId, fp);
      setTimeout(() => shots.delete(fileId), 45 * 60e3);
    }
    const img = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fp}`);
    if (!img.ok) return res.status(404).json({ error: 'telegram: ' + img.status });
    res.setHeader('Content-Type', img.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(await img.arrayBuffer()));
  } catch (e) { res.status(500).json({ error: e.message }); }
}

app.get('/api/shot/:orderId', guard, async (req, res) => {
  syncFromDisk();
  const o = state.orders[req.params.orderId];
  if (!o) return res.status(404).json({ error: 'order not found' });
  return sendShot(res, o.screenshotFileId);
});

app.get('/api/shotfile/:fileId', guard, (req, res) => sendShot(res, req.params.fileId));

app.get('/health', (req, res) => {
  res.json({ ok: true, rev: state.rev, stock: totalAvailable(state), sync: ghReady() ? (state.settings.githubLastError ? 'error' : 'ok') : 'off', up: Math.round(process.uptime()) });
});
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));
app.get('/', (req, res) => res.redirect('/panel'));

/* ================= BOOT ================= */
loadState();

(async () => {
  if (ghReady()) {
    try {
      const r = await withTimeout(pullState(), BOOT_PULL_TIMEOUT, 'boot pull');
      if (r.imported) console.log('state restored from repo, rev', state.rev);
      else if (r.legacy) console.log('legacy stock imported:', r.legacy);
      else await pushState('boot');
    } catch (e) {
      console.warn('boot pull failed:', e.message);
      if (/404/.test(e.message)) pushState('boot').catch(() => {});
    }
  }

  app.listen(PORT, '0.0.0.0', () => console.log(`panel: http://localhost:${PORT}/panel`));

  setInterval(syncFromDisk, DISK_POLL);
  heartbeat = setInterval(() => { if (dirty) flush().catch(() => {}); }, SYNC_HEARTBEAT);

  bot.launch().then(() => {
    console.log('bot online · rev', state.rev, '· stock', totalAvailable(state));
    notifyAdmins(`✅ Bot online · rev ${state.rev} · stock ${totalAvailable(state)}${ghReady() ? '' : ' · SYNC OFF'}`);
  });
})();

let closing = false;
const shutdown = async sig => {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  clearTimeout(pushTimer);
  try { await forceFlush(); } catch {}
  try { bot.stop(sig); } catch {}
  process.exit(0);
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', e => console.warn('[unhandled]', e && e.message));
