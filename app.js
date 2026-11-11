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
const isAdmin = id => ADMIN_IDS.includes(Number(id));

if (!BOT_TOKEN) { console.error('BOT_TOKEN missing in .env'); process.exit(1); }

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

const inr = p => { const v = Math.round(p) / 100; return '₹' + (Number.isInteger(v) ? v : v.toFixed(2)); };
const planById = (pr, id) => (pr.plans || []).find(p => p.id === id);
const priceFor = (pr, u, plan, dev) => {
  const base = u.tier === 'reseller' ? plan.reseller : plan.retail;
  return Math.ceil(base * (dev === 'unlimited' ? (pr.unlimitedMultiplier || 1.5) : 1) / 100) * 100;
};

/* ================= STORE ================= */
const FILE = path.join(DATA_DIR, 'state.json');
let state = null;
let queue = Promise.resolve();

const clone = o => JSON.parse(JSON.stringify(o));

function blank() {
  return {
    users: {}, orders: {}, stock: {},
    pricing: DEFAULT_PRICING(),
    settings: {
      upiId: process.env.UPI_ID || '',
      upiName: process.env.UPI_NAME || 'PC5 ANDROID',
      botMaintenance: false,
      maintenanceMsg: 'Bot is under maintenance. Try again shortly.',
      minTopup: 2000, maxTopup: 500000
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
  if (!s.pricing || !Array.isArray(s.pricing.plans)) s.pricing = b.pricing;
  return s;
}

function writeSync(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

function loadState() {
  try {
    state = normalize(fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null);
  } catch (e) {
    console.warn('state unreadable, starting fresh:', e.message);
    state = blank();
  }
  if (!fs.existsSync(FILE)) writeSync(state);
}

function log(actor, text) {
  state.log.push({ at: new Date().toISOString(), actor: String(actor), text: String(text).slice(0, 300) });
  if (state.log.length > 500) state.log = state.log.slice(-500);
}

function mutate(fn) {
  queue = queue.then(async () => {
    const work = clone(state);
    const out = await fn(work);
    writeSync(work);
    state = work;
    return out;
  }, () => {});
  return queue;
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
  Object.values(s.stock).filter(k => k.status === 'available' && k.planId === plan && k.deviceLimit === dev).length;

function claimKey(s, plan, dev, uid, oid) {
  const hit = Object.values(s.stock).find(k => k.status === 'available' && k.planId === plan && k.deviceLimit === dev);
  if (!hit) return null;
  hit.status = 'sold';
  hit.soldAt = new Date().toISOString();
  hit.soldTo = uid;
  hit.orderId = oid;
  return hit;
}

/* ================= BOT ================= */
const bot = new Telegraf(BOT_TOKEN);
const pending = new Map();

const BTN = { buy: '🛒 Buy Key', credit: '➕ Add Credit', balance: '💰 Balance', mykeys: '🔑 My Keys', reseller: '🏪 Reseller', help: '❓ Help' };
const menu = () => Markup.keyboard([[BTN.buy, BTN.credit], [BTN.balance, BTN.mykeys], [BTN.reseller, BTN.help]]).resize();

async function notifyAdmins(text, opts = {}) {
  for (const a of ADMIN_IDS) bot.telegram.sendMessage(a, text, opts).catch(() => {});
}

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
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
  `*How it works*\n\n1. Add Credit — pick amount, pay the UPI QR, send screenshot.\n2. We verify and credit you manually.\n3. Buy Key — pick plan and device limit.\n\n*Reseller* — pay ${inr(state.pricing.resellerFee)} once, then every key is at reseller rate.`,
  { parse_mode: 'Markdown', ...menu() }
));

bot.hears(BTN.balance, async ctx => {
  const u = state.users[String(ctx.from.id)];
  if (!u) return ctx.reply('/start first');
  await ctx.reply(`💰 Balance: *${inr(u.credit)}*\nTier: ${u.tier.toUpperCase()}\nKeys: ${u.keyCount}\nSpent: ${inr(u.totalSpent)}`, { parse_mode: 'Markdown' });
});

bot.hears(BTN.mykeys, async ctx => {
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
    return { order: s.orders[id], upiId: s.settings.upiId, upiName: s.settings.upiName };
  });

  if (!out.upiId) return ctx.reply('UPI not configured. Ping support.');
  const upi = `upi://pay?pa=${encodeURIComponent(out.upiId)}&pn=${encodeURIComponent(out.upiName)}&am=${(amount / 100).toFixed(2)}&cu=INR&tn=PC5-${out.order.id}`;
  const png = await QRCode.toBuffer(upi, { width: 640, margin: 1 });
  await ctx.replyWithPhoto({ source: png }, {
    caption: `*Order #${out.order.id}*\nAmount: *${inr(amount)}*\nUPI: \`${out.upiId}\`\n\nPay exactly, then send the screenshot here.`,
    parse_mode: 'Markdown'
  });
  pending.set(ctx.from.id, { action: 'shot', orderId: out.order.id });
}

bot.action(/^tup:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  try { await makeTopup(ctx, Number(ctx.match[1])); } catch (e) { ctx.reply(e.message); }
});

bot.action('tup:custom', async ctx => {
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { action: 'amount' });
  await ctx.reply(`Send the rupee amount (${inr(state.settings.minTopup)}–${inr(state.settings.maxTopup)}):`);
});

bot.on(['photo', 'document'], async ctx => {
  const st = pending.get(ctx.from.id);
  const open = Object.values(state.orders)
    .filter(o => o.userId === Number(ctx.from.id) && o.type !== 'key' && o.status === 'awaiting_payment')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const order = (st && st.orderId && state.orders[st.orderId]) || open[0];
  if (!order || order.status !== 'awaiting_payment') return ctx.reply('No open order. Press ➕ Add Credit.');

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
  pending.set(ctx.from.id, { action: 'reason', orderId: ctx.match[1] });
  await ctx.answerCbQuery();
  await ctx.reply(`Reason for #${ctx.match[1]}? ("-" to skip)`);
});

/* ---- buy ---- */
function buyKb(u) {
  const rows = [];
  for (const p of state.pricing.plans) {
    if (!p.on) continue;
    if (!availCount(state, p.id, 'single') && !availCount(state, p.id, 'unlimited')) continue;
    rows.push([Markup.button.callback(`${p.label} — ${inr(priceFor(state.pricing, u, p, 'single'))}`, `plan:${p.id}`)]);
  }
  return Markup.inlineKeyboard(rows);
}

bot.hears(BTN.buy, async ctx => {
  const u = state.users[String(ctx.from.id)];
  if (!u) return ctx.reply('/start first');
  const kb = buyKb(u);
  if (!kb.reply_markup.inline_keyboard.length) return ctx.reply('📦 Out of stock.');
  await ctx.reply(`🛒 *Buy a Key*\nBalance: ${inr(u.credit)}`, { parse_mode: 'Markdown', ...kb });
});

bot.action(/^plan:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const u = state.users[String(ctx.from.id)];
  const p = planById(state.pricing, ctx.match[1]);
  if (!p) return;
  const rows = [];
  if (availCount(state, p.id, 'single')) rows.push([Markup.button.callback(`1 Device — ${inr(priceFor(state.pricing, u, p, 'single'))}`, `dev:${p.id}:single`)]);
  if (availCount(state, p.id, 'unlimited')) rows.push([Markup.button.callback(`Unlimited — ${inr(priceFor(state.pricing, u, p, 'unlimited'))}`, `dev:${p.id}:unlimited`)]);
  rows.push([Markup.button.callback('‹ Back', 'home')]);
  await ctx.editMessageText(`*${p.label}* — choose device limit`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) });
});

bot.action('home', async ctx => { await ctx.answerCbQuery(); await ctx.editMessageText('Use the menu.', menu()); });

bot.action(/^dev:(.+):(single|unlimited)$/, async ctx => {
  await ctx.answerCbQuery();
  const u = state.users[String(ctx.from.id)];
  const p = planById(state.pricing, ctx.match[1]);
  const dev = ctx.match[2];
  if (!p) return;
  const price = priceFor(state.pricing, u, p, dev);
  await ctx.editMessageText(
    `*Confirm*\n${p.label} · ${dev}\nPrice *${inr(price)}*\nBalance ${inr(u.credit)}` + (u.credit < price ? `\n\n⚠️ Short ${inr(price - u.credit)}` : ''),
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`✅ Pay ${inr(price)}`, `pay:${p.id}:${dev}`)], [Markup.button.callback('‹ Back', `plan:${p.id}`)]]) }
  );
});

bot.action(/^pay:(.+):(single|unlimited)$/, async ctx => {
  const planId = ctx.match[1], dev = ctx.match[2];
  const u0 = state.users[String(ctx.from.id)];
  const p0 = planById(state.pricing, planId);
  if (!p0) return ctx.answerCbQuery('Gone');
  if (u0.credit < priceFor(state.pricing, u0, p0, dev)) return ctx.answerCbQuery('Not enough balance', { show_alert: true });

  let out;
  try {
    out = await mutate(s => {
      const u = s.users[String(ctx.from.id)];
      const p = planById(s.pricing, planId);
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
  const u = state.users[String(ctx.from.id)];
  if (u.tier === 'reseller') return ctx.reply('🏪 Already a reseller.');
  const fee = inr(state.pricing.resellerFee);
  const sample = state.pricing.plans.filter(p => p.on).slice(0, 3).map(p => `• ${p.label}: ${inr(p.retail)} → *${inr(p.reseller)}*`).join('\n');
  await ctx.reply(`🏪 *Reseller Pack*\nOne-time *${fee}*\n\n${sample}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`Pay ${fee}`, 'rsl')]]) });
});

bot.action('rsl', async ctx => {
  await ctx.answerCbQuery();
  const u = state.users[String(ctx.from.id)];
  if (u.tier === 'reseller') return ctx.reply('Already a reseller.');
  if (Object.values(state.orders).some(o => o.type === 'reseller' && o.userId === u.id && o.status === 'awaiting_payment'))
    return ctx.reply('You already have a reseller order open.');

  const fee = state.pricing.resellerFee;
  const order = await mutate(s => {
    const id = String(s.counters.nextOrder++);
    s.orders[id] = { id, userId: u.id, username: u.username, type: 'reseller', amount: fee, status: 'awaiting_payment', screenshotFileId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return s.orders[id];
  });
  const upi = `upi://pay?pa=${encodeURIComponent(state.settings.upiId)}&pn=${encodeURIComponent(state.settings.upiName)}&am=${(fee / 100).toFixed(2)}&cu=INR&tn=PC5RSL-${order.id}`;
  const png = await QRCode.toBuffer(upi, { width: 640, margin: 1 });
  pending.set(ctx.from.id, { action: 'shot', orderId: order.id });
  await ctx.replyWithPhoto({ source: png }, { caption: `*Reseller #${order.id}*\n*${inr(fee)}*\nUPI \`${state.settings.upiId}\`\n\nPay, then send screenshot.`, parse_mode: 'Markdown' });
});

/* ---- text states ---- */
bot.on('text', async ctx => {
  const st = pending.get(ctx.from.id);
  if (!st) return;

  if (st.action === 'amount') {
    const r = Number(ctx.message.text.replace(/[^\d.]/g, ''));
    if (!r) return ctx.reply('Send a number.');
    pending.delete(ctx.from.id);
    try { await makeTopup(ctx, Math.round(r * 100)); } catch (e) { ctx.reply(e.message); }
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
  const us = Object.values(state.users);
  await ctx.reply(`${us.length} users · ${us.filter(u => u.tier === 'reseller').length} resellers\n` +
    `${Object.values(state.stock).filter(k => k.status === 'available').length} in stock\n` +
    `${inr(us.reduce((a, u) => a + u.credit, 0))} credit held`);
});
bot.command('stock', async ctx => {
  if (!isAdmin(ctx.from.id)) return;
  await ctx.reply(state.pricing.plans.map(p => `${p.label}: ${availCount(state, p.id, 'single')} single / ${availCount(state, p.id, 'unlimited')} unl`).join('\n'));
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
app.use(express.json({ limit: '8mb' }));

const sessions = new Map();
const shots = new Map();
const eq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const jar = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(p => {
  const i = p.indexOf('='); return i > 0 ? [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())] : null;
}).filter(Boolean));

function guard(req, res, next) {
  const t = jar(req).sid;
  if (!t || !sessions.get(t) || sessions.get(t) < Date.now()) return res.status(401).json({ error: 'unauthorized' });
  if (req.method === 'POST' && req.headers['x-panel'] !== '1') return res.status(401).json({ error: 'header' });
  next();
}

app.post('/api/login', (req, res) => {
  if (!eq((req.body || {}).password || '', PANEL_PASSWORD)) return res.status(401).json({ error: 'wrong password' });
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, Date.now() + 8 * 3600e3);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  res.json({ ok: true });
});

app.post('/api/logout', guard, (req, res) => {
  sessions.delete(jar(req).sid);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/state', guard, (req, res) => {
  const st = Object.values(state.stock);
  const summary = {};
  for (const p of state.pricing.plans) summary[p.id] = {
    single: st.filter(k => k.status === 'available' && k.planId === p.id && k.deviceLimit === 'single').length,
    unlimited: st.filter(k => k.status === 'available' && k.planId === p.id && k.deviceLimit === 'unlimited').length
  };
  res.json({
    stats: {
      users: Object.keys(state.users).length,
      resellers: Object.values(state.users).filter(u => u.tier === 'reseller').length,
      creditHeld: Object.values(state.users).reduce((a, u) => a + u.credit, 0),
      pending: Object.values(state.orders).filter(o => o.status === 'pending_review').length,
      sold: Object.values(state.orders).filter(o => o.type === 'key').length,
      available: st.filter(k => k.status === 'available').length
    },
    users: Object.values(state.users).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    orders: Object.values(state.orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200),
    stockSummary: summary,
    stock: st.filter(k => k.status === 'available').slice(0, 400),
    pricing: state.pricing,
    settings: state.settings,
    log: state.log.slice(-80).reverse()
  });
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

app.post('/api/stock/add', guard, async (req, res) => {
  const { planId, deviceLimit, text } = req.body || {};
  if (!planById(state.pricing, planId)) return res.status(400).json({ error: 'bad plan' });
  const dev = deviceLimit === 'unlimited' ? 'unlimited' : 'single';
  const keys = String(text || '').split(/[\s,;]+/).map(k => k.trim().toUpperCase()).filter(Boolean);
  if (!keys.length) return res.status(400).json({ error: 'no keys' });

  const out = await mutate(s => {
    let added = 0, dupes = 0;
    for (const k of keys) {
      if (s.stock[k]) { dupes++; continue; }
      s.stock[k] = { key: k, planId, deviceLimit: dev, status: 'available', addedAt: new Date().toISOString(), soldAt: null, soldTo: null, orderId: null };
      added++;
    }
    log('panel', `stock +${added}`);
    return { added, dupes };
  });
  res.json({ ok: true, ...out });
});

app.post('/api/stock/gen', guard, async (req, res) => {
  const { planId, deviceLimit, count } = req.body || {};
  if (!planById(state.pricing, planId)) return res.status(400).json({ error: 'bad plan' });
  const dev = deviceLimit === 'unlimited' ? 'unlimited' : 'single';
  const n = Math.min(Math.max(Number(count) || 1, 1), 500);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const added = await mutate(s => {
    let made = 0;
    for (let i = 0; i < n; i++) {
      let k;
      do { k = 'PC5-' + Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (s.stock[k]);
      s.stock[k] = { key: k, planId, deviceLimit: dev, status: 'available', addedAt: new Date().toISOString(), soldAt: null, soldTo: null, orderId: null };
      made++;
    }
    log('panel', `stock gen +${made}`);
    return made;
  });
  res.json({ ok: true, added });
});

app.post('/api/stock/remove', guard, async (req, res) => {
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
  res.send(JSON.stringify(state, null, 2));
});

app.post('/api/restore', guard, async (req, res) => {
  await mutate(s => { Object.keys(s).forEach(k => delete s[k]); Object.assign(s, normalize(req.body)); });
  res.json({ ok: true });
});

app.post('/api/genkey', guard, async (req, res) => {
  const { userId, planId, deviceLimit } = req.body || {};
  const u = state.users[String(userId)];
  const p = planById(state.pricing, planId);
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

app.get('/api/shot/:orderId', guard, async (req, res) => {
  const o = state.orders[req.params.orderId];
  if (!o || !o.screenshotFileId) return res.status(404).end();
  try {
    let fp = shots.get(o.screenshotFileId);
    if (!fp) {
      const j = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(o.screenshotFileId)}`)).json();
      if (!j.ok) return res.status(404).end();
      fp = j.result.file_path;
      shots.set(o.screenshotFileId, fp);
      setTimeout(() => shots.delete(o.screenshotFileId), 45 * 60e3);
    }
    const img = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fp}`);
    if (!img.ok) return res.status(404).end();
    res.setHeader('Content-Type', img.headers.get('content-type') || 'image/jpeg');
    res.send(Buffer.from(await img.arrayBuffer()));
  } catch { res.status(500).end(); }
});

app.get('/panel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));
app.get('/', (req, res) => res.redirect('/panel'));

/* ================= BOOT ================= */
loadState();
app.listen(PORT, '0.0.0.0', () => console.log(`panel: http://localhost:${PORT}/panel`));
bot.launch().then(() => {
  console.log('bot online');
  notifyAdmins('✅ Bot online');
});
process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
process.on('unhandledRejection', e => console.warn('[unhandled]', e && e.message));
