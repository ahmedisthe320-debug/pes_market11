'use strict';
// سوق حسابات بيس: خادم بدون أي مكتبات خارجية (Node 18+)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'data.json');

const LISTING_FEE = Number(process.env.LISTING_FEE) || 5; // جنيه، رسوم عرض الحساب
const COMMISSION_PCT = Number(process.env.COMMISSION_PCT) || 10; // نسبتك من سعر الحساب
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES) || 90; // الانتظار قبل التحويل للبائع
const ORDER_EXPIRY_MIN = Number(process.env.ORDER_EXPIRY_MIN) || 60; // مهلة دفع المشتري

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- التخزين ----------
let db = {
  config: { vodafoneNumber: process.env.VODAFONE_NUMBER || '01055783862' },
  users: {}, listings: {}, orders: {}, sessions: {},
};
if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

// ---------- التشفير (بيانات حسابات كونامي) ----------
const KEY = (() => {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const f = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
})();
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

// ---------- كلمات السر ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

if (!process.env.ADMIN_PASSWORD && !db.config.adminHash) {
  const pw = crypto.randomBytes(9).toString('base64url');
  db.config.adminSalt = crypto.randomBytes(16).toString('hex');
  db.config.adminHash = hashPw(pw, db.config.adminSalt);
  save();
  console.log('\n=== كلمة سر لوحة المالك (تظهر مرة واحدة فقط) ===\n' + pw + '\n===============================================\n');
}
function checkAdmin(pw) {
  if (process.env.ADMIN_PASSWORD) return safeEq(pw, process.env.ADMIN_PASSWORD);
  return safeEq(hashPw(pw, db.config.adminSalt), db.config.adminHash);
}

// ---------- أدوات ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const now = () => Date.now();
const id = () => crypto.randomBytes(8).toString('hex');
const PHONE_RE = /^01[0125]\d{8}$/;
const str = (v, min, max, label) => {
  if (typeof v !== 'string') throw new HttpError(400, `${label} مطلوب`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${label} لازم يكون من ${min} إلى ${max} حرف`);
  return s;
};
const phone = (v, label) => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, '') : '';
  if (!PHONE_RE.test(s)) throw new HttpError(400, `${label} لازم يكون رقم موبايل مصري صحيح (11 رقم)`);
  return s;
};
const commissionOf = (price) => Math.round((price * COMMISSION_PCT) / 100);
// ممنوع أي وسيلة تواصل في عنوان ووصف الحساب (أرقام، واتساب، إيميل...) عشان التعامل كله يمشي من خلالك
const CONTACT_RE = /(\d[\s\-.]*){8,}|واتس|whats|telegram|تليجرام|تيليجرام|فيسبوك|facebook|messenger|ماسنجر|instagram|انستا|@/i;

const rate = new Map();
function limit(key, max, windowMs) {
  const t = now();
  const r = rate.get(key);
  if (!r || r.reset < t) { rate.set(key, { n: 1, reset: t + windowMs }); return; }
  if (++r.n > max) throw new HttpError(429, 'محاولات كتير، استنى شوية وجرّب تاني');
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function newSession(res, req, data, ttlMs) {
  const t = crypto.randomBytes(32).toString('hex');
  db.sessions[t] = { ...data, exp: now() + ttlMs };
  save();
  const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`);
}
function getSession(req) {
  const t = parseCookies(req).sid;
  const s = t && db.sessions[t];
  if (!s || s.exp < now()) return null;
  return { token: t, ...s };
}

// تنظيف دوري: طلبات انتهت مهلة دفعها وجلسات منتهية
function sweep() {
  let changed = false;
  for (const o of Object.values(db.orders)) {
    if (o.status === 'awaiting_payment' && o.expiresAt < now()) {
      o.status = 'cancelled';
      const l = db.listings[o.listingId];
      if (l && l.status === 'reserved') l.status = 'available';
      changed = true;
    }
  }
  for (const [t, s] of Object.entries(db.sessions)) if (s.exp < now()) { delete db.sessions[t]; changed = true; }
  if (changed) save();
}

// ---------- عرض البيانات ----------
const publicListing = (l) => ({ id: l.id, title: l.title, price: l.price, description: l.description, createdAt: l.createdAt });
const SHOW_CREDS = new Set(['delivered', 'codes_requested', 'codes_submitted', 'codes_relayed', 'email_changed', 'confirmed', 'disputed', 'paid_out']);
function orderView(o, withCreds) {
  const l = db.listings[o.listingId];
  const v = {
    id: o.id, listingId: o.listingId, title: l ? l.title : '', price: o.price, status: o.status,
    createdAt: o.createdAt, expiresAt: o.expiresAt, payoutDueAt: o.payoutDueAt || null,
  };
  if (withCreds && SHOW_CREDS.has(o.status) && l) v.credentials = decrypt(l.credEnc);
  if (withCreds && o.status === 'codes_relayed') v.codes = { code1: o.code1, code2: o.code2 };
  return v;
}

// ---------- المسارات ----------
const routes = [];
const route = (method, pattern, auth, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), auth, fn });
const userOf = (s) => {
  const u = s && s.role === 'user' && db.users[s.userId];
  if (!u) throw new HttpError(401, 'سجّل دخولك الأول');
  return u;
};

route('GET', '/api/config', null, () => ({
  vodafoneNumber: db.config.vodafoneNumber || '', listingFee: LISTING_FEE, commissionPct: COMMISSION_PCT, holdMinutes: HOLD_MINUTES,
}));
route('GET', '/api/me', null, ({ session }) => {
  const u = session && session.role === 'user' && db.users[session.userId];
  return { user: u ? { id: u.id, name: u.name, phone: u.phone } : null, admin: !!(session && session.role === 'admin') };
});
route('POST', '/api/register', null, ({ req, res, body }) => {
  limit('reg:' + req.socket.remoteAddress, 10, 3600e3);
  const name = str(body.name, 2, 40, 'الاسم');
  const ph = phone(body.phone, 'رقم الموبايل');
  const pw = str(body.password, 6, 100, 'كلمة السر');
  if (Object.values(db.users).some((u) => u.phone === ph)) throw new HttpError(409, 'الرقم ده مسجّل قبل كده');
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: id(), name, phone: ph, salt, hash: hashPw(pw, salt), createdAt: now() };
  db.users[u.id] = u;
  newSession(res, req, { role: 'user', userId: u.id }, 7 * 864e5);
  return { user: { id: u.id, name: u.name, phone: u.phone } };
});
route('POST', '/api/login', null, ({ req, res, body }) => {
  const ph = phone(body.phone, 'رقم الموبايل');
  limit('login:' + req.socket.remoteAddress + ph, 8, 600e3);
  const u = Object.values(db.users).find((x) => x.phone === ph);
  const pw = typeof body.password === 'string' ? body.password : '';
  if (!u || !safeEq(hashPw(pw, u.salt), u.hash)) throw new HttpError(401, 'الرقم أو كلمة السر غلط');
  newSession(res, req, { role: 'user', userId: u.id }, 7 * 864e5);
  return { user: { id: u.id, name: u.name, phone: u.phone } };
});
route('POST', '/api/logout', null, ({ res, session }) => {
  if (session) { delete db.sessions[session.token]; save(); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/listings', null, () =>
  Object.values(db.listings).filter((l) => l.status === 'available').sort((a, b) => b.createdAt - a.createdAt).map(publicListing));

route('POST', '/api/listings', 'user', ({ session, body }) => {
  const u = userOf(session);
  // السؤال الأول: الحساب مربوط بإيه؟
  if (body.linkType !== 'konami') {
    if (body.linkType === 'google' || body.linkType === 'both') throw new HttpError(422, 'مش هقدر أعرض الحساب ده');
    throw new HttpError(400, 'اختار الحساب مربوط بإيه');
  }
  const title = str(body.title, 3, 80, 'عنوان الحساب');
  const description = str(body.description, 3, 1000, 'الوصف');
  if (CONTACT_RE.test(title) || CONTACT_RE.test(description)) throw new HttpError(422, 'ممنوع كتابة أرقام موبايل أو واتساب أو إيميلات أو أي وسيلة تواصل في العنوان أو الوصف');
  const price = Number(body.price);
  if (!Number.isInteger(price) || price < 50 || price > 100000) throw new HttpError(400, 'السعر لازم يكون رقم صحيح من 50 إلى 100000 جنيه');
  const email = str(body.email, 3, 120, 'إيميل كونامي');
  const password = str(body.password, 1, 120, 'كلمة سر كونامي');
  const payoutPhone = phone(body.payoutPhone, 'رقم فودافون كاش للاستلام');
  const feeRef = str(body.feeRef, 3, 60, 'مرجع تحويل رسوم العرض');
  const l = {
    id: id(), sellerId: u.id, title, description, price, payoutPhone, feeRef, linkType: 'konami',
    credEnc: encrypt({ email, password }), status: 'pending_fee', createdAt: now(),
  };
  db.listings[l.id] = l;
  save();
  return { id: l.id, status: l.status };
});

route('GET', '/api/my/listings', 'user', ({ session }) => {
  const u = userOf(session);
  return Object.values(db.listings).filter((l) => l.sellerId === u.id).sort((a, b) => b.createdAt - a.createdAt).map((l) => {
    const o = Object.values(db.orders).filter((x) => x.listingId === l.id && x.status !== 'cancelled' && x.status !== 'refunded').pop();
    return {
      id: l.id, title: l.title, price: l.price, status: l.status, createdAt: l.createdAt,
      sale: o ? {
        orderId: o.id, status: o.status, sellerAmount: o.sellerAmount, commission: o.commission, payoutDueAt: o.payoutDueAt || null,
        // البائع يعرف بس إن الأكواد مطلوبة، من غير أي بيانات عن المشتري
        codesNeeded: o.status === 'codes_requested' || o.status === 'codes_submitted',
        codesSubmitted: o.status === 'codes_submitted',
      } : null,
    };
  });
});

route('POST', '/api/orders', 'user', ({ session, body }) => {
  const u = userOf(session);
  const l = db.listings[body.listingId];
  if (!l || l.status !== 'available') throw new HttpError(409, 'الحساب ده مش متاح دلوقتي');
  if (l.sellerId === u.id) throw new HttpError(400, 'مينفعش تشتري حسابك');
  const commission = commissionOf(l.price);
  const o = {
    id: id(), listingId: l.id, buyerId: u.id, price: l.price, commission, sellerAmount: l.price - commission,
    status: 'awaiting_payment', createdAt: now(), expiresAt: now() + ORDER_EXPIRY_MIN * 60e3,
  };
  l.status = 'reserved';
  db.orders[o.id] = o;
  save();
  return orderView(o, false);
});
route('GET', '/api/my/orders', 'user', ({ session }) => {
  const u = userOf(session);
  return Object.values(db.orders).filter((o) => o.buyerId === u.id).sort((a, b) => b.createdAt - a.createdAt).map((o) => orderView(o, true));
});
const ownOrder = (session, oid) => {
  const u = userOf(session);
  const o = db.orders[oid];
  if (!o || o.buyerId !== u.id) throw new HttpError(404, 'الطلب مش موجود');
  return o;
};
route('GET', '/api/orders/(\\w+)', 'user', ({ session, params }) => orderView(ownOrder(session, params[0]), true));
route('POST', '/api/orders/(\\w+)/pay', 'user', ({ session, params, body }) => {
  const o = ownOrder(session, params[0]);
  if (o.status !== 'awaiting_payment') throw new HttpError(409, 'مينفعش تبعت بيانات الدفع في الحالة دي');
  o.payerPhone = phone(body.payerPhone, 'الرقم اللي حوّلت منه');
  o.payRef = str(body.ref, 3, 60, 'مرجع التحويل');
  o.status = 'payment_submitted';
  o.expiresAt = null;
  save();
  return orderView(o, false);
});
route('POST', '/api/orders/(\\w+)/cancel', 'user', ({ session, params }) => {
  const o = ownOrder(session, params[0]);
  if (o.status !== 'awaiting_payment') throw new HttpError(409, 'مينفعش تلغي الطلب بعد التحويل');
  o.status = 'cancelled';
  const l = db.listings[o.listingId];
  if (l && l.status === 'reserved') l.status = 'available';
  save();
  return orderView(o, false);
});
// الأكواد بتمشي دايماً عن طريق المالك: البائع -> المالك -> المشتري. مفيش أي تواصل مباشر بينهم.
const CODE_RE = /^[A-Za-z0-9]{4,12}$/;
const code = (v, label) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!CODE_RE.test(s)) throw new HttpError(400, `${label} لازم يكون من 4 إلى 12 حرف أو رقم بس`);
  return s;
};
// المشتري بدأ تغيير الإيميل ومحتاج أكواد التحقق من البائع
route('POST', '/api/orders/(\\w+)/request-codes', 'user', ({ session, params }) => {
  const o = ownOrder(session, params[0]);
  if (o.status !== 'delivered' && o.status !== 'codes_relayed') throw new HttpError(409, 'مينفعش تطلب الأكواد في الحالة دي');
  o.status = 'codes_requested';
  o.code1 = o.code2 = null;
  save();
  return orderView(o, true);
});
// المشتري خلّص تغيير الإيميل
route('POST', '/api/orders/(\\w+)/email-changed', 'user', ({ session, params }) => {
  const o = ownOrder(session, params[0]);
  if (o.status !== 'codes_relayed') throw new HttpError(409, 'مينفعش في الحالة دي');
  o.status = 'email_changed';
  o.emailChangedAt = now();
  o.code1 = o.code2 = null;
  save();
  return orderView(o, true);
});
// البائع بيبعت الكودين (للمالك الأول، والمالك هو اللي يمرّرهم للمشتري)
route('POST', '/api/seller/orders/(\\w+)/codes', 'user', ({ session, params, body }) => {
  const u = userOf(session);
  const o = db.orders[params[0]];
  const l = o && db.listings[o.listingId];
  if (!o || !l || l.sellerId !== u.id) throw new HttpError(404, 'الطلب مش موجود');
  if (o.status !== 'codes_requested' && o.status !== 'codes_submitted') throw new HttpError(409, 'مفيش طلب أكواد دلوقتي');
  o.code1 = code(body.code1, 'الكود الأول');
  o.code2 = code(body.code2, 'الكود التاني');
  o.status = 'codes_submitted';
  save();
  return { ok: true };
});
// المشتري بيرد: الحساب تمام وكونامي فقط؟
route('POST', '/api/orders/(\\w+)/confirm', 'user', ({ session, params, body }) => {
  const o = ownOrder(session, params[0]);
  if (o.status !== 'email_changed') throw new HttpError(409, 'لازم البائع يأكد تغيير الإيميل الأول');
  if (body.ok === true && body.konamiOnly === true) {
    o.status = 'confirmed';
    o.confirmedAt = now();
    o.payoutDueAt = now() + HOLD_MINUTES * 60e3;
  } else {
    o.status = 'disputed';
    o.disputeNote = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  }
  save();
  return orderView(o, true);
});

// ---------- لوحة المالك ----------
route('POST', '/api/admin/login', null, ({ req, res, body }) => {
  limit('admin:' + req.socket.remoteAddress, 6, 600e3);
  if (typeof body.password !== 'string' || !checkAdmin(body.password)) throw new HttpError(401, 'كلمة السر غلط');
  newSession(res, req, { role: 'admin' }, 12 * 3600e3);
  return { ok: true };
});
const adminOrder = (o) => {
  const l = db.listings[o.listingId] || {};
  const buyer = db.users[o.buyerId] || {};
  const seller = db.users[l.sellerId] || {};
  return {
    id: o.id, title: l.title, price: o.price, commission: o.commission, sellerAmount: o.sellerAmount, status: o.status,
    buyerName: buyer.name, buyerPhone: buyer.phone, payerPhone: o.payerPhone, payRef: o.payRef,
    sellerName: seller.name, payoutPhone: l.payoutPhone, payoutDueAt: o.payoutDueAt || null,
    disputeNote: o.disputeNote || '', createdAt: o.createdAt,
    code1: o.status === 'codes_submitted' ? o.code1 : null, code2: o.status === 'codes_submitted' ? o.code2 : null,
  };
};
route('GET', '/api/admin/overview', 'admin', () => {
  const listings = Object.values(db.listings);
  const orders = Object.values(db.orders);
  const paidOut = orders.filter((o) => o.status === 'paid_out');
  const feeCount = listings.filter((l) => l.feeConfirmed).length;
  return {
    config: db.config,
    settings: { listingFee: LISTING_FEE, commissionPct: COMMISSION_PCT, holdMinutes: HOLD_MINUTES },
    stats: {
      commissions: paidOut.reduce((s, o) => s + o.commission, 0),
      fees: feeCount * LISTING_FEE,
      pendingPayouts: orders.filter((o) => o.status === 'confirmed').reduce((s, o) => s + o.sellerAmount, 0),
      sold: paidOut.length,
    },
    pendingListings: listings.filter((l) => l.status === 'pending_fee').map((l) => ({
      id: l.id, title: l.title, price: l.price, feeRef: l.feeRef, sellerName: (db.users[l.sellerId] || {}).name,
      sellerPhone: (db.users[l.sellerId] || {}).phone, description: l.description, createdAt: l.createdAt,
    })),
    orders: orders.filter((o) => o.status !== 'cancelled').sort((a, b) => b.createdAt - a.createdAt).map(adminOrder),
  };
});
route('GET', '/api/admin/listings/(\\w+)/credentials', 'admin', ({ params }) => {
  const l = db.listings[params[0]];
  if (!l) throw new HttpError(404, 'الحساب مش موجود');
  return decrypt(l.credEnc);
});
route('POST', '/api/admin/listings/(\\w+)/(approve|reject)', 'admin', ({ params }) => {
  const l = db.listings[params[0]];
  if (!l || l.status !== 'pending_fee') throw new HttpError(409, 'مينفعش في الحالة دي');
  if (params[1] === 'approve') { l.status = 'available'; l.feeConfirmed = true; } else l.status = 'rejected';
  save();
  return { ok: true };
});
const adminOrderAction = (o, action) => {
  const l = db.listings[o.listingId];
  const need = (...st) => { if (!st.includes(o.status)) throw new HttpError(409, 'مينفعش الإجراء ده في حالة الطلب الحالية'); };
  switch (action) {
    case 'payment-ok': need('payment_submitted', 'awaiting_payment'); o.status = 'paid'; o.paidAt = now(); o.expiresAt = null; break;
    case 'deliver': need('paid'); o.status = 'delivered'; o.deliveredAt = now(); break;
    case 'payout':
      need('confirmed');
      if (now() < o.payoutDueAt) throw new HttpError(409, 'لسه مخلصش وقت الانتظار');
      o.status = 'paid_out'; o.paidOutAt = now(); if (l) l.status = 'sold'; break;
    case 'relay': need('codes_submitted'); o.status = 'codes_relayed'; break;
    case 'email-changed': need('codes_relayed'); o.status = 'email_changed'; o.emailChangedAt = now(); o.code1 = o.code2 = null; break;
    case 'release': need('disputed'); o.status = 'confirmed'; o.payoutDueAt = now(); break;
    case 'refund': need('paid', 'delivered', 'codes_requested', 'codes_submitted', 'codes_relayed', 'email_changed', 'disputed', 'payment_submitted'); o.status = 'refunded'; if (l) l.status = 'removed'; break;
    case 'cancel': need('awaiting_payment', 'payment_submitted'); o.status = 'cancelled'; if (l && l.status === 'reserved') l.status = 'available'; break;
    default: throw new HttpError(400, 'إجراء غير معروف');
  }
};
route('POST', '/api/admin/orders/(\\w+)/(payment-ok|deliver|relay|email-changed|payout|release|refund|cancel)', 'admin', ({ params }) => {
  const o = db.orders[params[0]];
  if (!o) throw new HttpError(404, 'الطلب مش موجود');
  adminOrderAction(o, params[1]);
  save();
  return adminOrder(o);
});
// المالك يدخل الأكواد بنفسه (لو استلمها من البائع برّه التطبيق) وتتمرر للمشتري على طول
route('POST', '/api/admin/orders/(\\w+)/codes', 'admin', ({ params, body }) => {
  const o = db.orders[params[0]];
  if (!o) throw new HttpError(404, 'الطلب مش موجود');
  if (o.status !== 'codes_requested' && o.status !== 'codes_submitted') throw new HttpError(409, 'مفيش طلب أكواد على الطلب ده');
  o.code1 = code(body.code1, 'الكود الأول');
  o.code2 = code(body.code2, 'الكود التاني');
  o.status = 'codes_relayed';
  save();
  return adminOrder(o);
});
route('POST', '/api/admin/config', 'admin', ({ body }) => {
  db.config.vodafoneNumber = phone(body.vodafoneNumber, 'رقم فودافون كاش');
  save();
  return { ok: true };
});

// ---------- الخادم ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { reject(new HttpError(413, 'الطلب كبير')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); } catch { reject(new HttpError(400, 'بيانات غير صحيحة')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      sweep();
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'مرفوض');
        if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'نوع الطلب غير مدعوم');
      }
      const session = getSession(req);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        if (r.auth === 'admin' && !(session && session.role === 'admin')) throw new HttpError(401, 'للمالك فقط');
        if (r.auth === 'user' && !(session && session.role === 'user')) throw new HttpError(401, 'سجّل دخولك الأول');
        const body = req.method === 'POST' ? await readBody(req) : {};
        return sendJson(res, 200, r.fn({ req, res, body, params: m.slice(1), session }));
      }
      throw new HttpError(404, 'غير موجود');
    }
    // ملفات الواجهة
    let rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (!rel) rel = 'index.html';
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), { 'Content-Type': MIME['.html'] });
    }
    send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'حصل خطأ في الخادم' });
  }
});
server.listen(PORT, () => console.log(`سوق بيس شغّال على http://localhost:${PORT}`));
