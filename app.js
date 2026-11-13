'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Telegraf, Markup } = require('telegraf');

/* ------------------------------------------------------------------ config */

const {
  BOT_TOKEN,
  ADMIN_IDS = '',
  PANEL_PASSWORD = 'admin',
  DATA_DIR = './data',
  PORT = 8080,
  UPI_ID = '',
  UPI_NAME = '',
  GITHUB_TOKEN = '',
  GITHUB_REPO = '',
  GITHUB_PATH = 'data/state.json',
  GITHUB_BRANCH = 'main',
  RENDER_EXTERNAL_URL = '',
  SESSION_SECRET = crypto.randomBytes(32).toString('hex'),
} = process.env;

const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing');
  process.exit(1);
}

const ADMINS = ADMIN_IDS.split(',').map((s) => s.trim()).filter(Boolean).map(Number);

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_STOCK = path.join(process.cwd(), 'stock.json');
const SHOT_DIR = path.join(DATA_DIR, 'screens');
const LOG_CAP = 500;

fs.mkdirSync(SHOT_DIR, { recursive: true });

/* ------------------------------------------------------------------- state */

function blank() {
  return {
    rev: 0,
    updatedAt: Date.now(),
    pending: {},
    settings: {
      maintenance: false,
      banner: 'Welcome to PC5 ANDROID.',
      upiId: UPI_ID,
      upiName: UPI_NAME,
      resellerFee: 19900,
      resellerDiscount: 20,
      plans: [
        { id: 'p1', name: 'PC5 1 Day', price: 2900, devices: 1 },
        { id: 'p2', name: 'PC5 7 Days', price: 14900, devices: 1 },
        { id: 'p3', name: 'PC5 30 Days', price: 39900, devices: 1 },
      ],
      tiers: [
        { label: '1 Device', mult: 1 },
        { label: '2 Devices', mult: 1.6 },
        { label: '3 Devices', mult: 2.2 },
      ],
    },
    users: {},
    orders: [],
    stock: {},
    log: [],
  };
}

function normalize(s) {
  const b = blank();
  if (!s || typeof s !== 'object') return b;

  const out = {
    rev: Number(s.rev) || 0,
    updatedAt: Number(s.updatedAt) || Date.now(),
    pending: s.pending && typeof s.pending === 'object' ? s.pending : {},
    settings: Object.assign(b.settings, s.settings || {}),
    users: s.users && typeof s.users === 'object' ? s.users : {},
    orders: Array.isArray(s.orders) ? s.orders : [],
    stock: s.stock && typeof s.stock === 'object' ? s.stock : {},
    log: Array.isArray(s.log) ? s.log.slice(-LOG_CAP) : [],
  };

  if (!Array.isArray(out.settings.plans) || !out.settings.plans.length) {
    out.settings.plans = b.settings.plans;
  }
  if (!Array.isArray(out.settings.tiers) || !out.settings.tiers.length) {
    out.settings.tiers = b.settings.tiers;
  }

  for (const p of out.settings.plans) {
    if (!Array.isArray(out.stock[p.id])) out.stock[p.id] = [];
  }

  for (const u of Object.values(out.users)) {
    u.balance = Number(u.balance) || 0;
    u.reseller = Boolean(u.reseller);
    u.banned = Boolean(u.banned);
  }

  return out;
}

let state = blank();
let chain = Promise.resolve();
let pushTimer = null;
let pushing = false;

function readLocal() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeLocal() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

function log(kind, text) {
  state.log.push({ at: Date.now(), kind, text: String(text).slice(0, 300) });
  if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
}

function mutate(fn, opts = {}) {
  const run = chain.then(async () => {
    const draft = JSON.parse(JSON.stringify(state));
    if (!draft.pending) draft.pending = {};
    const result = await fn(draft);
    draft.rev += 1;
    draft.updatedAt = Date.now();
    state = normalize(draft);
    writeLocal();
    if (!opts.quiet) schedulePush();
    broadcast();
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

function ensureUser(src) {
  const id = String(src.id);
  if (!state.users[id]) {
    state.users[id] = {
      id,
      name: [src.first_name, src.last_name].filter(Boolean).join(' ') || 'User',
      username: src.username || '',
      balance: 0,
      reseller: false,
      banned: false,
      joined: Date.now(),
      lastSeen: Date.now(),
    };
  } else {
    state.users[id].lastSeen = Date.now();
    if (src.username) state.users[id].username = src.username;
  }
  return state.users[id];
}

function priceFor(s, plan, tierIndex) {
  const tier = s.settings.tiers[tierIndex] || s.settings.tiers[0];
  return Math.round(plan.price * (tier ? tier.mult : 1));
}

function claimKey(draft, planId) {
  const list = draft.stock[planId];
  if (!Array.isArray(list)) return null;
  const idx = list.findIndex((k) => !k.sold);
  if (idx === -1) return null;
  list[idx].sold = true;
  return list[idx].key;
}

const shortId = (p) => p + crypto.randomBytes(4).toString('hex').toUpperCase();

/* -------------------------------------------------------------- github sync */

const ghHeaders = () => ({
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
  'User-Agent': 'pc5-bot',
});

const ghUrl = () =>
  `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_PATH)}`;

async function ghSha() {
  const r = await fetch(`${ghUrl()}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('sha ' + r.status);
  return (await r.json()).sha;
}

function snapshot() {
  const c = JSON.parse(JSON.stringify(state));
  if (c.settings.github) delete c.settings.github.token;
  return c;
}

async function pushNow() {
  if (!GITHUB_TOKEN || !GITHUB_REPO || pushing) return false;
  pushing = true;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const sha = await ghSha();
        const body = {
          message: `state sync: auto (rev ${state.rev})`,
          content: Buffer.from(JSON.stringify(snapshot())).toString('base64'),
          branch: GITHUB_BRANCH,
        };
        if (sha) body.sha = sha;
        const r = await fetch(ghUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
        if (r.ok) return true;
        if (r.status !== 409 && r.status !== 422) throw new Error('push ' + r.status);
      } catch (e) {
        if (attempt === 3) console.error('push failed:', e.message);
        else await new Promise((res) => setTimeout(res, 400 * attempt));
      }
    }
    return false;
  } finally {
    pushing = false;
  }
}

function schedulePush() {
  if (!GITHUB_TOKEN) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushNow().catch(() => {});
  }, 700);
}

async function pullRemote() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return null;
  try {
    const r = await fetch(`${ghUrl()}?ref=${GITHUB_BRANCH}`, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('pull ' + r.status);
    const j = await r.json();
    return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  } catch (e) {
    console.error('pull failed:', e.message);
    return null;
  }
}

/* ------------------------------------------------------------------- bot */

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => console.error('bot error', ctx?.update?.update_id, err));

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const u = ensureUser(ctx.from);
  if (u.banned) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('You are banned').catch(() => {});
    return ctx.reply('You are banned.').catch(() => {});
  }
  if (state.settings.maintenance && !ADMINS.includes(ctx.from.id)) {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Maintenance').catch(() => {});
    return ctx.reply('Under maintenance, back shortly.').catch(() => {});
  }
  return next();
});

const menu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('Buy', 'buy')],
    [Markup.button.callback('Balance', 'balance'), Markup.button.callback('My Keys', 'mykeys')],
    [Markup.button.callback('Top Up', 'topup')],
    [Markup.button.callback('Become Reseller', 'reseller')],
  ]);

const HOME = (name) => `Hi ${name}.\n\n${state.settings.banner}\n\nUse the buttons below.`;

bot.start(async (ctx) => {
  const id = String(ctx.from.id);
  const user = await mutate((d) => {
    const u =
      d.users[id] ||
      (d.users[id] = {
        id,
        name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'User',
        username: ctx.from.username || '',
        balance: 0,
        reseller: false,
        banned: false,
        joined: Date.now(),
        lastSeen: Date.now(),
      });
    u.lastSeen = Date.now();
    if (ctx.from.username) u.username = ctx.from.username;
    return u;
  });
  await ctx.reply(HOME(user.name), menu());
});

bot.action('home', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = state.users[String(ctx.from.id)];
  await ctx.editMessageText(HOME(u ? u.name : 'there'), menu()).catch(() => {});
});

bot.action('balance', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = state.users[String(ctx.from.id)];
  await ctx
    .editMessageText(`Balance: ₹${((u?.balance || 0) / 100).toFixed(2)}`, Markup.inlineKeyboard([[Markup.button.callback('Back', 'home')]]))
    .catch(() => {});
});

bot.action('mykeys', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const mine = state.orders.filter((o) => o.userId === String(ctx.from.id) && o.key);
  const text = mine.length ? mine.slice(-15).map((o) => `${o.planName}\n\`${o.key}\``).join('\n\n') : 'No keys yet.';
  await ctx
    .editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Back', 'home')]]) })
    .catch(() => {});
});

bot.action('buy', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const rows = state.settings.plans.map((p) => [
    Markup.button.callback(`${p.name} — ₹${(p.price / 100).toFixed(0)}`, `plan:${p.id}`),
  ]);
  rows.push([Markup.button.callback('Back', 'home')]);
  await ctx.editMessageText('Choose a plan:', Markup.inlineKeyboard(rows)).catch(() => {});
});

bot.action(/^plan:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const plan = state.settings.plans.find((p) => p.id === ctx.match[1]);
  if (!plan) return;
  const rows = state.settings.tiers.map((t, i) => [
    Markup.button.callback(`${t.label} — ₹${(priceFor(state, plan, i) / 100).toFixed(0)}`, `tier:${plan.id}:${i}`),
  ]);
  rows.push([Markup.button.callback('Back', 'buy')]);
  await ctx.editMessageText(`Plan: ${plan.name}\nChoose devices:`, Markup.inlineKeyboard(rows)).catch(() => {});
});

bot.action(/^tier:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const plan = state.settings.plans.find((p) => p.id === ctx.match[1]);
  if (!plan) return;
  const ti = Number(ctx.match[2]);
  const price = priceFor(state, plan, ti);
  const tier = state.settings.tiers[ti];
  const u = state.users[String(ctx.from.id)];
  await ctx
    .editMessageText(
      `Plan: ${plan.name}\nDevices: ${tier.label}\nPrice: ₹${(price / 100).toFixed(2)}\nBalance: ₹${((u?.balance || 0) / 100).toFixed(2)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Confirm', `confirm:${plan.id}:${ti}`)],
        [Markup.button.callback('Back', `plan:${plan.id}`)],
      ])
    )
    .catch(() => {});
});

bot.action(/^confirm:([^:]+):(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const planId = ctx.match[1];
  const ti = Number(ctx.match[2]);
  const uid = String(ctx.from.id);

  const res = await mutate((d) => {
    const plan = d.settings.plans.find((p) => p.id === planId);
    if (!plan) return { err: 'Plan gone.' };
    const price = priceFor(d, plan, ti);
    const user = d.users[uid];
    if (!user) return { err: 'Unknown user.' };
    if (user.balance < price) return { err: `Need ₹${((price - user.balance) / 100).toFixed(2)} more.` };
    const key = claimKey(d, planId);
    if (!key) return { err: 'OUT_OF_STOCK' };

    user.balance -= price;
    const order = {
      id: shortId('K-'),
      userId: uid,
      planId,
      planName: plan.name,
      devices: (d.settings.tiers[ti] || {}).label || '1 Device',
      amount: price,
      status: 'paid',
      key,
      createdAt: Date.now(),
    };
    d.orders.push(order);
    log('sale', `${user.name} bought ${plan.name} (${key})`);
    return { ok: true, order };
  });

  if (res.err === 'OUT_OF_STOCK') {
    return ctx
      .editMessageText('Out of stock for this plan.', Markup.inlineKeyboard([[Markup.button.callback('Back', 'buy')]]))
      .catch(() => {});
  }
  if (res.err) {
    return ctx.editMessageText(res.err, Markup.inlineKeyboard([[Markup.button.callback('Back', 'buy')]])).catch(() => {});
  }

  await ctx
    .editMessageText(`Purchase complete.\n\nPlan: ${res.order.planName}\nKey:\n\`${res.order.key}\``, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('Menu', 'home')]]),
    })
    .catch(() => {});
});

/* ------------------------------------------------------------------ top up */

const PRESETS = [5000, 10000, 25000, 50000];

bot.action('topup', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const rows = [];
  for (let i = 0; i < PRESETS.length; i += 2) {
    rows.push(PRESETS.slice(i, i + 2).map((p) => Markup.button.callback(`₹${p / 100}`, `amt:${p}`)));
  }
  rows.push([Markup.button.callback('Custom', 'amt:custom')]);
  rows.push([Markup.button.callback('Back', 'home')]);
  await ctx.editMessageText('Choose top-up amount:', Markup.inlineKeyboard(rows)).catch(() => {});
});

async function sendPay(ctx, amount) {
  const id = shortId('T-');
  await mutate((d) => {
    d.orders.push({ id, userId: String(ctx.from.id), amount, status: 'awaiting_payment', createdAt: Date.now() });
    d.pending[String(ctx.from.id)] = id;
  });

  const upi = `upi://pay?pa=${encodeURIComponent(state.settings.upiId)}&pn=${encodeURIComponent(
    state.settings.upiName
  )}&am=${(amount / 100).toFixed(2)}&cu=INR`;

  const caption =
    `Pay ₹${(amount / 100).toFixed(2)} to\n${state.settings.upiId}\n(${state.settings.upiName})\n\nOrder ${id}\nThen send the payment screenshot here.`;
  const kb = Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'home')]]);

  try {
    const staticQr = path.join(__dirname, 'public', 'qr.jpg');
    if (fs.existsSync(staticQr)) {
      await ctx.replyWithPhoto({ source: staticQr }, { caption, ...kb });
    } else {
      const buf = await QRCode.toBuffer(upi, { width: 512, margin: 1 });
      await ctx.replyWithPhoto({ source: buf }, { caption, ...kb });
    }
  } catch {
    await ctx.reply(`${caption}\n\n${upi}`, kb);
  }
}

bot.action(/^amt:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendPay(ctx, Number(ctx.match[1]));
});

bot.action('amt:custom', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await mutate((d) => {
    d.pending[String(ctx.from.id)] = 'CUSTOM';
  }, { quiet: true });
  await ctx
    .editMessageText('Send the amount in rupees (e.g. 150):', Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'home')]]))
    .catch(() => {});
});

bot.on('text', async (ctx, next) => {
  const uid = String(ctx.from.id);
  if (state.pending?.[uid] !== 'CUSTOM') return next();

  const rupees = Number(ctx.message.text.replace(/[^\d.]/g, ''));
  if (!rupees || rupees < 1) return ctx.reply('Send a valid amount in rupees.');

  await mutate((d) => {
    if (d.pending) delete d.pending[uid];
  }, { quiet: true });
  await sendPay(ctx, Math.round(rupees * 100));
});

/* -------------------------------------------------------------- screenshot */

bot.on('photo', async (ctx) => {
  const uid = String(ctx.from.id);

  const orderId =
    (state.pending?.[uid] && state.pending[uid] !== 'CUSTOM' ? state.pending[uid] : null) ||
    state.orders.filter((o) => o.userId === uid && o.status === 'awaiting_payment').slice(-1)[0]?.id;

  if (!orderId) return ctx.reply('No open top-up. Tap Top Up first.');

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const file = `${orderId}.jpg`;

  try {
    const link = await ctx.telegram.getFileLink(photo.file_id);
    const res = await fetch(link.href);
    fs.writeFileSync(path.join(SHOT_DIR, file), Buffer.from(await res.arrayBuffer()));
  } catch {
    return ctx.reply('Could not download the screenshot, send it again.');
  }

  const updated = await mutate((d) => {
    const order = d.orders.find((o) => o.id === orderId);
    if (!order) return null;
    order.status = 'pending_review';
    order.shot = file;
    order.submittedAt = Date.now();
    if (d.pending) delete d.pending[uid];
    log('payment', `${d.users[uid]?.name || uid} submitted ${order.id}`);
    return order;
  });

  if (!updated) return ctx.reply('Order not found.');

  await ctx.reply(`Screenshot received for ${updated.id}. Waiting for approval.`);

  const caption =
    `Payment review\n\nOrder: ${updated.id}\nUser: ${ctx.from.id} (${ctx.from.username || '-'})\nAmount: ₹${(
      updated.amount / 100
    ).toFixed(2)}\nBalance: ₹${((state.users[uid]?.balance || 0) / 100).toFixed(2)}`;

  for (const admin of ADMINS) {
    try {
      await bot.telegram.sendPhoto(
        admin,
        { source: path.join(SHOT_DIR, file) },
        {
          caption,
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Approve', `apv:${updated.id}`), Markup.button.callback('Reject', `rej:${updated.id}`)],
          ]),
        }
      );
    } catch (e) {
      console.error('admin notify failed', admin, e.message);
    }
  }
});

/* ---------------------------------------------------------------- reseller */

bot.action('reseller', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = state.users[String(ctx.from.id)];
  if (u?.reseller) {
    return ctx
      .editMessageText(`You are a reseller. Discount: ${state.settings.resellerDiscount}%.`, Markup.inlineKeyboard([[Markup.button.callback('Back', 'home')]]))
      .catch(() => {});
  }
  await ctx
    .editMessageText(
      `Reseller fee: ₹${(state.settings.resellerFee / 100).toFixed(2)}\nBalance: ₹${((u?.balance || 0) / 100).toFixed(2)}`,
      Markup.inlineKeyboard([[Markup.button.callback('Pay from balance', 'resbuy')], [Markup.button.callback('Back', 'home')]])
    )
    .catch(() => {});
});

bot.action('resbuy', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const uid = String(ctx.from.id);
  const res = await mutate((d) => {
    const user = d.users[uid];
    const fee = d.settings.resellerFee;
    if (!user) return 'Unknown user.';
    if (user.reseller) return 'Already a reseller.';
    if (user.balance < fee) return 'Insufficient balance.';
    user.balance -= fee;
    user.reseller = true;
    log('reseller', `${user.name} upgraded`);
    return null;
  });
  await ctx
    .editMessageText(res || `You are now a reseller. ${state.settings.resellerDiscount}% off all plans.`, Markup.inlineKeyboard([[Markup.button.callback('Menu', 'home')]]))
    .catch(() => {});
});

/* ---------------------------------------------------------- admin commands */

const isAdmin = (ctx) => ADMINS.includes(ctx.from.id);

bot.command('panel', (ctx) => isAdmin(ctx) && ctx.reply(PUBLIC_URL ? `${PUBLIC_URL}/panel` : 'No PUBLIC_URL set.'));

bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const revenue = state.orders.filter((o) => o.status === 'paid' || o.status === 'approved').reduce((a, o) => a + (o.amount || 0), 0);
  await ctx.reply(
    `Users: ${Object.keys(state.users).length}\nPending: ${state.orders.filter((o) => o.status === 'pending_review').length}\nSold: ${state.orders.filter((o) => o.status === 'paid').length}\nRevenue: ₹${(revenue / 100).toFixed(2)}`
  );
});

bot.command('stock', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply(
    state.settings.plans
      .map((p) => {
        const l = state.stock[p.id] || [];
        return `${p.name}: ${l.filter((k) => !k.sold).length} available / ${l.length}`;
      })
      .join('\n')
  );
});

bot.command('sync', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.reply((await pushNow()) ? `Pushed rev ${state.rev}.` : 'Push failed.');
});

bot.command('pull', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const remote = await pullRemote();
  if (!remote) return ctx.reply('Nothing to pull.');
  if ((remote.rev || 0) <= state.rev) return ctx.reply(`Remote ${remote.rev} not newer than local ${state.rev}.`);
  state = normalize(remote);
  writeLocal();
  broadcast();
  await ctx.reply(`Pulled rev ${state.rev}.`);
});

bot.command('addcredit', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id, rupees] = ctx.message.text.split(/\s+/).slice(1);
  if (!id || !rupees) return ctx.reply('Usage: /addcredit <id> <rupees>');
  const ok = await mutate((d) => {
    const u = d.users[id];
    if (!u) return false;
    u.balance += Math.round(Number(rupees) * 100);
    log('credit', `${id} +₹${rupees}`);
    return true;
  });
  await ctx.reply(ok ? 'Credited.' : 'User not found.');
});

bot.command('setreseller', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id, f] = ctx.message.text.split(/\s+/).slice(1);
  const ok = await mutate((d) => {
    const u = d.users[id];
    if (!u) return false;
    u.reseller = f !== '0';
    return true;
  });
  await ctx.reply(ok ? 'Updated.' : 'User not found.');
});

bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const [id, f] = ctx.message.text.split(/\s+/).slice(1);
  const ok = await mutate((d) => {
    const u = d.users[id];
    if (!u) return false;
    u.banned = f !== '0';
    return true;
  });
  await ctx.reply(ok ? 'Updated.' : 'User not found.');
});

bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text = ctx.message.text.replace(/^\/broadcast\s*/, '');
  if (!text) return ctx.reply('Usage: /broadcast <text>');
  let sent = 0;
  for (const id of Object.keys(state.users)) {
    try {
      await bot.telegram.sendMessage(id, text);
      sent++;
    } catch {}
    await new Promise((r) => setTimeout(r, 40));
  }
  await ctx.reply(`Sent to ${sent}.`);
});

/* ------------------------------------------------------------------ panel */

const app = express();

app.get('/health', (req, res) => res.json({ ok: true, rev: state.rev, up: Math.floor(process.uptime()) }));

if (PUBLIC_URL) app.use(bot.webhookCallback('/tg'));

const api = express.Router();
api.use(express.json({ limit: '4mb' }));

const attempts = new Map();

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');

function authed(req) {
  const c = cookies(req).sid;
  if (!c) return false;
  const [v, s] = c.split('.');
  if (!v || !s) return false;
  const want = Buffer.from(sign(v));
  const got = Buffer.from(s);
  if (want.length !== got.length) return false;
  if (!crypto.timingSafeEqual(want, got)) return false;
  return Number(v) > Date.now();
}

function requireAuth(req, res, next) {
  if (!authed(req)) return res.status(401).json({ error: 'auth' });
  if (req.method === 'POST' && req.get('x-panel') !== '1') return res.status(400).json({ error: 'missing x-panel' });
  next();
}

api.post('/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > 600000) {
    rec.n = 0;
    rec.t = now;
  }
  if (rec.n >= 12) return res.status(429).json({ error: 'too many' });

  const given = Buffer.from(String(req.body.password || ''));
  const want = Buffer.from(PANEL_PASSWORD);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);

  if (!ok) {
    rec.n++;
    attempts.set(ip, rec);
    return res.status(401).json({ error: 'bad password' });
  }

  attempts.delete(ip);
  const exp = Date.now() + 8 * 3600 * 1000;
  res.setHeader(
    'Set-Cookie',
    `sid=${exp}.${sign(String(exp))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${PUBLIC_URL.startsWith('https') ? '; Secure' : ''}`
  );
  res.json({ ok: true });
});

api.get('/me', requireAuth, (req, res) => res.json({ ok: true }));

api.get('/state', requireAuth, (req, res) => {
  const s = snapshot();
  delete s.log;
  delete s.pending;
  res.json(s);
});

api.get('/log', requireAuth, (req, res) => res.json(state.log.slice(-200).reverse()));

const clients = new Set();

function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify({ rev: state.rev })}\n\n`;
  for (const c of clients) {
    try {
      c.write(payload);
    } catch {}
  }
}

api.get('/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: state\ndata: ${JSON.stringify({ rev: state.rev })}\n\n`);
  clients.add(res);
  const ka = setInterval(() => res.write(': ka\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ka);
    clients.delete(res);
  });
});

api.get('/shot/:id', requireAuth, (req, res) => {
  const o = state.orders.find((x) => x.id === req.params.id);
  if (!o || !o.shot) return res.status(404).end();
  const p = path.join(SHOT_DIR, path.basename(o.shot));
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

api.post('/orders/:id/approve', requireAuth, async (req, res) => {
  const out = await mutate((d) => {
    const o = d.orders.find((x) => x.id === req.params.id);
    if (!o || o.status !== 'pending_review') return { err: 'not pending' };
    o.status = 'approved';
    o.reviewedAt = Date.now();
    const u = d.users[o.userId];
    if (u) u.balance += o.amount;
    log('approve', `${o.id} ₹${(o.amount / 100).toFixed(2)}`);
    return { ok: true, userId: o.userId, amount: o.amount };
  });
  if (out.err) return res.status(400).json(out);
  try {
    await bot.telegram.sendMessage(out.userId, `Payment approved: ₹${(out.amount / 100).toFixed(2)} credited.`);
  } catch {}
  res.json({ ok: true });
});

api.post('/orders/:id/reject', requireAuth, async (req, res) => {
  const out = await mutate((d) => {
    const o = d.orders.find((x) => x.id === req.params.id);
    if (!o || o.status !== 'pending_review') return { err: 'not pending' };
    o.status = 'rejected';
    o.reviewedAt = Date.now();
    o.note = String(req.body.note || '').slice(0, 200);
    log('reject', o.id);
    return { ok: true, userId: o.userId };
  });
  if (out.err) return res.status(400).json(out);
  try {
    await bot.telegram.sendMessage(out.userId, `Payment rejected${req.body.note ? ': ' + req.body.note : '.'}`);
  } catch {}
  res.json({ ok: true });
});

bot.action(/^apv:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only');
  const out = await mutate((d) => {
    const o = d.orders.find((x) => x.id === ctx.match[1]);
    if (!o || o.status !== 'pending_review') return null;
    o.status = 'approved';
    o.reviewedAt = Date.now();
    const u = d.users[o.userId];
    if (u) u.balance += o.amount;
    log('approve', o.id);
    return o;
  });
  if (!out) return ctx.answerCbQuery('Not pending');
  await ctx.answerCbQuery('Approved');
  await ctx.editMessageCaption(`${ctx.callbackQuery.message.caption}\n\nAPPROVED`).catch(() => {});
  try {
    await bot.telegram.sendMessage(out.userId, `Payment approved: ₹${(out.amount / 100).toFixed(2)} credited.`);
  } catch {}
});

bot.action(/^rej:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Admins only');
  const out = await mutate((d) => {
    const o = d.orders.find((x) => x.id === ctx.match[1]);
    if (!o || o.status !== 'pending_review') return null;
    o.status = 'rejected';
    o.reviewedAt = Date.now();
    log('reject', o.id);
    return o;
  });
  if (!out) return ctx.answerCbQuery('Not pending');
  await ctx.answerCbQuery('Rejected');
  await ctx.editMessageCaption(`${ctx.callbackQuery.message.caption}\n\nREJECTED`).catch(() => {});
  try {
    await bot.telegram.sendMessage(out.userId, 'Payment rejected.');
  } catch {}
});

api.post('/users/:id/balance', requireAuth, async (req, res) => {
  const rupees = Number(req.body.rupees || 0);
  const ok = await mutate((d) => {
    const u = d.users[req.params.id];
    if (!u) return false;
    u.balance += Math.round(rupees * 100);
    log('credit', `${req.params.id} ${rupees >= 0 ? '+' : ''}₹${rupees}`);
    return true;
  });
  res.json({ ok });
});

api.post('/users/:id/flags', requireAuth, async (req, res) => {
  const ok = await mutate((d) => {
    const u = d.users[req.params.id];
    if (!u) return false;
    if (typeof req.body.reseller === 'boolean') u.reseller = req.body.reseller;
    if (typeof req.body.banned === 'boolean') u.banned = req.body.banned;
    return true;
  });
  res.json({ ok });
});

api.post('/users/:id/message', requireAuth, async (req, res) => {
  try {
    await bot.telegram.sendMessage(req.params.id, String(req.body.text || ''));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

api.post('/stock/add', requireAuth, async (req, res) => {
  const planId = String(req.body.planId || '');
  const keys = String(req.body.keys || '')
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  if (!keys.length) return res.status(400).json({ error: 'no keys' });

  const added = await mutate((d) => {
    if (!Array.isArray(d.stock[planId])) d.stock[planId] = [];
    const have = new Set(d.stock[planId].map((k) => k.key));
    let n = 0;
    for (const key of keys) {
      if (have.has(key)) continue;
      d.stock[planId].push({ key, sold: false, soldTo: null, soldAt: null });
      n++;
    }
    log('stock', `+${n} to ${planId}`);
    return n;
  });
  res.json({ ok: true, added });
});

api.post('/stock/generate', requireAuth, async (req, res) => {
  const planId = String(req.body.planId || '');
  const count = Math.min(Number(req.body.count || 1), 500);
  const prefix = String(req.body.prefix || 'PC5').toUpperCase();

  await mutate((d) => {
    if (!Array.isArray(d.stock[planId])) d.stock[planId] = [];
    for (let i = 0; i < count; i++) {
      d.stock[planId].push({ key: `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, sold: false, soldTo: null, soldAt: null });
    }
    log('stock', `generated ${count} for ${planId}`);
  });
  res.json({ ok: true, added: count });
});

api.post('/stock/remove', requireAuth, async (req, res) => {
  const planId = String(req.body.planId || '');
  const removed = await mutate((d) => {
    const before = (d.stock[planId] || []).length;
    d.stock[planId] = (d.stock[planId] || []).filter((k) => k.sold);
    return before - d.stock[planId].length;
  });
  res.json({ ok: true, removed });
});

api.get('/stock', requireAuth, (req, res) => {
  const out = {};
  for (const p of state.settings.plans) {
    const l = state.stock[p.id] || [];
    out[p.id] = { available: l.filter((k) => !k.sold).length, total: l.length };
  }
  res.json(out);
});

api.post('/settings', requireAuth, async (req, res) => {
  await mutate((d) => {
    const s = d.settings;
    if (typeof req.body.maintenance === 'boolean') s.maintenance = req.body.maintenance;
    if (typeof req.body.banner === 'string') s.banner = req.body.banner.slice(0, 500);
    if (typeof req.body.upiId === 'string') s.upiId = req.body.upiId.trim();
    if (typeof req.body.upiName === 'string') s.upiName = req.body.upiName.trim();
    if (req.body.resellerFee != null) s.resellerFee = Math.round(Number(req.body.resellerFee) * 100);
    if (req.body.resellerDiscount != null) s.resellerDiscount = Number(req.body.resellerDiscount);
    if (Array.isArray(req.body.plans)) {
      s.plans = req.body.plans
        .filter((p) => p && p.id && p.name)
        .map((p) => ({ id: String(p.id), name: String(p.name).slice(0, 60), price: Math.round(Number(p.price)), devices: Number(p.devices) || 1 }));
      for (const p of s.plans) if (!Array.isArray(d.stock[p.id])) d.stock[p.id] = [];
    }
    if (Array.isArray(req.body.tiers)) {
      s.tiers = req.body.tiers.filter((t) => t && t.label).map((t) => ({ label: String(t.label).slice(0, 30), mult: Number(t.mult) || 1 }));
    }
  });
  res.json({ ok: true });
});

api.post('/sync/push', requireAuth, async (req, res) => res.json({ ok: await pushNow() }));

api.post('/sync/pull', requireAuth, async (req, res) => {
  const remote = await pullRemote();
  if (!remote) return res.status(400).json({ error: 'no remote' });
  if ((remote.rev || 0) <= state.rev) return res.json({ ok: false, reason: 'local newer' });
  state = normalize(remote);
  writeLocal();
  broadcast();
  res.json({ ok: true, rev: state.rev });
});

app.use('/api', api);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));

/* ------------------------------------------------------------------- boot */

async function boot() {
  const local = readLocal();
  if (local) {
    state = normalize(local);
  } else {
    state = blank();
    const remote = await pullRemote();
    if (remote) state = normalize(remote);
  }

  let legacy = null;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_STOCK, 'utf8'));
  } catch {}
  if (legacy) {
    for (const [planId, arr] of Object.entries(legacy)) {
      if (!Array.isArray(arr)) continue;
      if (!Array.isArray(state.stock[planId])) state.stock[planId] = [];
      const have = new Set(state.stock[planId].map((k) => k.key));
      for (const item of arr) {
        const key = typeof item === 'string' ? item : item.key;
        if (key && !have.has(key)) state.stock[planId].push({ key, sold: false, soldTo: null, soldAt: null });
      }
    }
    log('boot', 'legacy stock.json merged');
  }

  writeLocal();

  const remote = await pullRemote();
  if (remote && (remote.rev || 0) > state.rev) {
    state = normalize(remote);
    writeLocal();
  }

  if (PUBLIC_URL) {
    try {
      await bot.telegram.setWebhook(`${PUBLIC_URL}/tg`, { drop_pending_updates: false });
      const info = await bot.telegram.getWebhookInfo();
      if (!info.url) throw new Error('webhook not registered');
      console.log('webhook set:', info.url);
    } catch (e) {
      console.error('webhook failed, polling:', e.message);
      await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
      bot.launch({ dropPendingUpdates: false });
    }
  } else {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
    bot.launch({ dropPendingUpdates: false });
    console.log('polling');
  }

  const self = PUBLIC_URL || RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  if (self) setInterval(() => fetch(`${self}/health`).catch(() => {}), 4 * 60 * 1000);

  setInterval(() => {
    if (pushTimer === null) pushNow().catch(() => {});
  }, 10 * 60 * 1000);
}

process.on('SIGTERM', async () => {
  try {
    if (GITHUB_TOKEN) await pushNow();
  } catch {}
  process.exit(0);
});

app.listen(Number(PORT), () => console.log(`listening on ${PORT}`));

boot().catch((e) => {
  console.error('boot failed', e);
});
