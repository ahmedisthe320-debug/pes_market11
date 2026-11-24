'use strict';
const main = document.getElementById('main');
const nav = document.getElementById('nav');
const BASE_TITLE = 'سوق بيس';
let me = null, isAdmin = false, config = {};
let pollTimer = null, refreshFn = null, rerenderFn = null;

// ---------- أدوات ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
async function api(path, body) {
  const opt = { credentials: 'same-origin' };
  if (body !== undefined) { opt.method = 'POST'; opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  let data = {};
  try { data = await r.json(); } catch { /* فاضي */ }
  if (!r.ok) { const e = new Error(data.error || 'حصل خطأ'); e.status = r.status; throw e; }
  return data;
}
let toastT;
function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 4500);
}
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message, true); }
}
const money = (n) => Number(n).toLocaleString('en-US') + ' جنيه';
function copyBtn(text) {
  return h('button', {
    class: 'btn ghost small', type: 'button',
    onclick: async () => { try { await navigator.clipboard.writeText(text); toast('اتنسخ'); } catch { toast('انسخه يدوي من الشاشة', true); } },
  }, 'نسخ');
}
function copyLine(label, value) {
  return h('div', { class: 'copyline' }, h('span', { class: 'muted', text: label + ':' }), h('code', { text: value }), copyBtn(value));
}
function field(label, name, attrs = {}, tag = 'input') {
  return h('label', {}, label, h(tag, { name, required: true, ...attrs }));
}
function kv(rows) {
  const dl = h('dl', { class: 'kv' });
  rows.filter(Boolean).forEach(([k, v, ltr]) => { dl.append(h('dt', { text: k }), h('dd', { class: ltr ? 'ltr' : '', text: v })); });
  return dl;
}
function go(hash) { if ((location.hash || '#/') === hash) router(); else location.hash = hash; }

// عدّاد تنازلي؛ لما يخلص الصفحة بتتحدّث عشان الأزرار تتفعّل
function countdown(due) {
  const el = h('strong', { 'data-due': due });
  el.dataset.done = due - Date.now() <= 0 ? '1' : '';
  tick(el);
  return el;
}
function tick(el) {
  const left = Number(el.dataset.due) - Date.now();
  if (left <= 0) {
    el.textContent = 'خلص الوقت';
    if (!el.dataset.done) { el.dataset.done = '1'; if (rerenderFn) rerenderFn(); }
    return;
  }
  el.textContent = `${Math.floor(left / 60000)} دقيقة و ${Math.floor((left % 60000) / 1000)} ثانية`;
}
setInterval(() => document.querySelectorAll('[data-due]').forEach(tick), 1000);

// تحميل دوري: بيعيد الرسم بس لما البيانات تتغيّر
function poll(loader, render, ms = 10000) {
  let key = null, last = null;
  const run = async () => {
    try {
      const d = await loader();
      const k = JSON.stringify(d);
      if (k !== key) { key = k; last = d; render(d); }
    } catch (e) {
      if (e.status === 401) go('#/auth');
      else if (key === null) main.replaceChildren(h('p', { class: 'empty', text: e.message }));
    }
  };
  refreshFn = run;
  rerenderFn = () => { if (last) render(last); };
  pollTimer = setInterval(run, ms);
  return run();
}

// ---------- القائمة والتنقل ----------
async function loadMe() { const d = await api('/api/me'); me = d.user; isAdmin = d.admin; }
function renderNav() {
  const here = location.hash || '#/';
  const links = [['#/', 'السوق'], ['#/sell', 'بيع حساب']];
  if (me) links.push(['#/orders', 'مشترياتي'], ['#/sales', 'مبيعاتي']);
  if (isAdmin) links.push(['#/admin', 'لوحة المالك']);
  nav.replaceChildren(...links.map(([href, label]) => h('a', { href, 'aria-current': here === href ? 'page' : null }, label)));
  if (me || isAdmin) nav.append(h('button', { type: 'button', onclick: logout }, me ? `خروج (${me.name})` : 'خروج'));
  else nav.append(h('a', { href: '#/auth', 'aria-current': here === '#/auth' ? 'page' : null }, 'دخول / تسجيل'));
}
async function logout() { await act(() => api('/api/logout', {})); go('#/'); }

async function router() {
  clearInterval(pollTimer); pollTimer = null; refreshFn = null; rerenderFn = null;
  document.title = BASE_TITLE;
  try { await loadMe(); config = await api('/api/config'); } catch { /* الخادم مش متاح */ }
  renderNav();
  const [, page, arg] = (location.hash || '#/').split('/');
  const pages = { '': market, buy: () => buyPage(arg), order: () => orderPage(arg), sell, orders: ordersPage, sales: salesPage, auth, admin: adminPage };
  try { await (pages[page || ''] || market)(); } catch (e) { main.replaceChildren(h('p', { class: 'empty', text: e.message })); }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

// ---------- السوق والشراء ----------
async function market() {
  const list = await api('/api/listings');
  main.replaceChildren(
    h('h1', { text: 'حسابات بيس للبيع' }),
    h('p', { class: 'lead', text: 'كل الحسابات مربوطة بكونامي فقط. الدفع والتسليم كله بيمشي من خلال المنصة.' }),
    list.length
      ? h('div', { class: 'grid' }, list.map((l) => h('article', { class: 'card' },
        h('h3', { text: l.title }),
        h('p', { class: 'desc', text: l.description }),
        h('div', { class: 'row' }, h('span', { class: 'price', text: money(l.price) }), h('a', { class: 'btn', href: '#/buy/' + l.id }, 'اشتري')))))
      : h('p', { class: 'empty', text: 'مفيش حسابات معروضة دلوقتي. ارجع بعدين.' }),
  );
}
async function buyPage(id) {
  if (!me) { location.hash = '#/auth'; return; }
  const l = (await api('/api/listings')).find((x) => x.id === id);
  if (!l) { main.replaceChildren(h('p', { class: 'empty', text: 'الحساب ده مش متاح دلوقتي.' }), h('a', { class: 'btn ghost', href: '#/' }, 'رجوع للسوق')); return; }
  main.replaceChildren(h('div', { class: 'panel stack' },
    h('h1', { text: l.title }),
    h('p', { class: 'desc', text: l.description }),
    h('div', { class: 'price', text: money(l.price) }),
    h('ul', {},
      h('li', { text: `بتدفع ${money(l.price)} على فودافون كاش، وبعد ما نستلم الفلوس بنسلمك بيانات الحساب.` }),
      h('li', { text: 'بتغيّر إيميل الحساب لإيميلك، وبنوصلك أكواد التحقق المطلوبة من خلالنا.' }),
      h('li', { text: `بعد ما تأكد إن الحساب شغّال وكونامي فقط، بنحوّل الفلوس للبائع بعد ${config.holdMinutes} دقيقة.` }),
      h('li', { text: 'التعامل كله من خلالنا. مفيش تواصل مباشر مع البائع.' })),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => act(async () => { const o = await api('/api/orders', { listingId: id }); location.hash = '#/order/' + o.id; }) }, 'تأكيد الشراء'),
      h('a', { class: 'btn ghost', href: '#/' }, 'رجوع'))));
}

const STEP_NAMES = ['الدفع', 'الاستلام', 'تغيير الإيميل', 'التأكيد', 'التحويل للبائع'];
const STEP_IDX = { awaiting_payment: 0, payment_submitted: 0, paid: 1, delivered: 2, codes_requested: 2, codes_submitted: 2, codes_relayed: 2, email_changed: 3, confirmed: 4, disputed: 4, paid_out: 5 };
const BUYER_STATUS = {
  awaiting_payment: 'مستني الدفع', payment_submitted: 'بنراجع التحويل', paid: 'تم الدفع', delivered: 'استلمت الحساب',
  codes_requested: 'مستني الأكواد', codes_submitted: 'مستني الأكواد', codes_relayed: 'غيّر الإيميل', email_changed: 'محتاج تأكيدك',
  confirmed: 'تم التأكيد', paid_out: 'مكتمل', disputed: 'قيد المراجعة', refunded: 'اتسترد', cancelled: 'ملغي',
};
const credBox = (c) => h('div', { class: 'note stack' }, h('strong', { text: 'بيانات الحساب' }), copyLine('إيميل كونامي', c.email), copyLine('كلمة السر', c.password));

async function orderPage(id) {
  if (!me) { location.hash = '#/auth'; return; }
  await poll(() => api('/api/orders/' + id), renderOrder);
}
function renderOrder(o) {
  const idx = STEP_IDX[o.status];
  const steps = idx === undefined ? null : h('ol', { class: 'steps' }, STEP_NAMES.map((n, i) => h('li', { class: i < idx ? 'done' : i === idx ? 'now' : '', text: n })));
  const post = (path, body, msg) => act(async () => { await api(`/api/orders/${o.id}/${path}`, body); if (refreshFn) await refreshFn(); }, msg);
  const parts = [];
  switch (o.status) {
    case 'awaiting_payment':
      parts.push(
        h('div', { class: 'note stack' },
          h('p', {}, 'حوّل ', h('strong', { text: money(o.price) }), ' على فودافون كاش للرقم:'),
          config.vodafoneNumber
            ? h('div', { class: 'copyline' }, h('span', { class: 'pay', text: config.vodafoneNumber }), copyBtn(config.vodafoneNumber))
            : h('p', { class: 'note bad', text: 'رقم الدفع لسه مش متحدد. كلّم صاحب المنصة.' }),
          h('p', { class: 'muted' }, 'مهلة الدفع: ', countdown(o.expiresAt))),
        h('form', {
          class: 'panel', onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); post('pay', { payerPhone: f.get('payerPhone'), ref: f.get('ref') }, 'وصلتنا بيانات التحويل'); },
        },
        h('p', { class: 'muted', text: 'بعد ما تحوّل، اكتب بيانات التحويل عشان نراجعه:' }),
        field('الرقم اللي حوّلت منه', 'payerPhone', { type: 'tel', inputmode: 'numeric', maxlength: 11, placeholder: '01xxxxxxxxx' }),
        field('رقم العملية أو آخر 4 أرقام', 'ref', { maxlength: 60, dir: 'ltr' }),
        h('button', { class: 'btn', type: 'submit' }, 'حوّلت الفلوس')),
        h('button', { class: 'btn danger', type: 'button', onclick: () => post('cancel', {}, 'اتلغى الطلب') }, 'إلغاء الطلب'));
      break;
    case 'payment_submitted': parts.push(h('div', { class: 'note warn', text: 'بنراجع التحويل. أول ما نتأكد هنسلمك الحساب هنا (الصفحة بتتحدّث لوحدها).' })); break;
    case 'paid': parts.push(h('div', { class: 'note', text: 'استلمنا الفلوس. بنجهز لك بيانات الحساب دلوقتي.' })); break;
    case 'delivered':
      parts.push(credBox(o.credentials),
        h('div', { class: 'note stack' },
          h('p', { text: 'ادخل على الحساب وابدأ تغيير الإيميل لإيميلك. لما توصل لخطوة محتاج فيها أكواد التحقق، اضغط الزر وهنجيبها لك من خلالنا.' }),
          h('button', { class: 'btn', type: 'button', onclick: () => post('request-codes', {}, 'طلبنا الأكواد') }, 'محتاج الأكواد')));
      break;
    case 'codes_requested': case 'codes_submitted':
      parts.push(credBox(o.credentials), h('div', { class: 'note warn', text: 'طلبنا الأكواد. أول ما توصل هتظهر هنا (الصفحة بتتحدّث لوحدها).' }));
      break;
    case 'codes_relayed':
      parts.push(credBox(o.credentials),
        h('div', { class: 'note stack' }, h('strong', { text: 'أكواد التحقق' }), copyLine('الكود الأول', o.codes.code1), copyLine('الكود التاني', o.codes.code2),
          h('p', { class: 'muted', text: 'استخدمهم وكمّل تغيير الإيميل، وبعدها اضغط "غيّرت الإيميل".' }),
          h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => post('email-changed', {}, 'تمام') }, 'غيّرت الإيميل'),
            h('button', { class: 'btn ghost', type: 'button', onclick: () => post('request-codes', {}, 'طلبنا أكواد جديدة') }, 'الأكواد مش شغالة، اطلب جداد'))));
      break;
    case 'email_changed': {
      const note = h('textarea', { placeholder: 'لو في مشكلة، اشرحها هنا (بتوصل لصاحب المنصة بس)', maxlength: 500 });
      parts.push(credBox(o.credentials),
        h('div', { class: 'panel stack' },
          h('h3', { text: 'الحساب تمام وكونامي فقط؟' }),
          h('p', { class: 'muted', text: `لو أكدت، هنحوّل الفلوس للبائع بعد ${config.holdMinutes} دقيقة، ومش هتقدر ترجع في القرار.` }),
          note,
          h('div', { class: 'row' },
            h('button', { class: 'btn', type: 'button', onclick: () => post('confirm', { ok: true, konamiOnly: true }, 'شكراً، تم التأكيد') }, 'أيوه، الحساب تمام وكونامي فقط'),
            h('button', { class: 'btn danger', type: 'button', onclick: () => post('confirm', { ok: false, note: note.value }, 'وصلت المشكلة لصاحب المنصة') }, 'لأ، في مشكلة'))));
      break;
    }
    case 'confirmed': parts.push(credBox(o.credentials), h('div', { class: 'note', text: 'تم تأكيدك. بنحوّل الفلوس للبائع بعد فترة الانتظار.' })); break;
    case 'paid_out': parts.push(credBox(o.credentials), h('div', { class: 'note', text: 'العملية خلصت بنجاح. بالتوفيق مع الحساب.' })); break;
    case 'disputed': parts.push(credBox(o.credentials), h('div', { class: 'note warn', text: 'بنراجع المشكلة اللي بلّغت عنها وهنرد عليك.' })); break;
    case 'refunded': parts.push(h('div', { class: 'note warn', text: 'الطلب اتسترد. هنرجّع لك فلوسك.' })); break;
    default: parts.push(h('div', { class: 'note', text: 'الطلب ملغي.' }));
  }
  main.replaceChildren(h('div', { class: 'stack' }, h('h1', { text: o.title }), h('div', { class: 'price', text: money(o.price) }), steps, ...parts, h('a', { class: 'muted', href: '#/orders' }, 'كل مشترياتي')));
}
async function ordersPage() {
  if (!me) { location.hash = '#/auth'; return; }
  const list = await api('/api/my/orders');
  main.replaceChildren(h('h1', { text: 'مشترياتي' }), list.length
    ? h('div', { class: 'grid' }, list.map((o) => h('a', { class: 'card', href: '#/order/' + o.id, style: 'color:inherit;text-decoration:none' },
      h('h3', { text: o.title }), h('div', { class: 'row' }, h('span', { class: 'price', text: money(o.price) }), h('span', { class: 'badge', text: BUYER_STATUS[o.status] || o.status })))))
    : h('p', { class: 'empty', text: 'لسه ما اشتريتش حاجة.' }));
}

// ---------- البيع ----------
let sellType = null;
async function sell() {
  if (!me) { location.hash = '#/auth'; return; }
  sellType = null;
  renderSell();
}
function renderSell() {
  if (sellType === null) {
    const pick = (t, label) => h('button', { class: 'btn ghost', type: 'button', onclick: () => { sellType = t; renderSell(); } }, label);
    main.replaceChildren(h('div', { class: 'panel stack' },
      h('h1', { text: 'بيع حسابك' }),
      h('p', { class: 'lead', text: 'الأول: الحساب مربوط بإيه؟' }),
      pick('konami', 'كونامي فقط'), pick('google', 'جوجل فقط'), pick('both', 'جوجل وكونامي')));
    return;
  }
  if (sellType !== 'konami') {
    main.replaceChildren(h('div', { class: 'panel stack' },
      h('div', { class: 'note bad' }, h('strong', { text: 'مش هقدر أعرض الحساب ده.' })),
      h('p', { class: 'muted', text: 'بنقبل بس الحسابات المربوطة بكونامي وحدها. لو فصلت الحساب عن جوجل ارجع وجرّب تاني.' }),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { sellType = null; renderSell(); } }, 'رجوع')));
    return;
  }
  const submit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    act(async () => { await api('/api/listings', { ...f, price: Number(f.price), linkType: 'konami' }); go('#/sales'); }, 'اتبعت الحساب، مستني تأكيد الرسوم');
  };
  main.replaceChildren(h('div', { class: 'stack' },
    h('h1', { text: 'بيانات الحساب' }),
    h('div', { class: 'note stack' },
      h('p', {}, 'رسوم العرض ', h('strong', { text: money(config.listingFee) }), '. حوّلها الأول على فودافون كاش للرقم:'),
      config.vodafoneNumber ? h('div', { class: 'copyline' }, h('span', { class: 'pay', text: config.vodafoneNumber }), copyBtn(config.vodafoneNumber)) : h('p', { text: 'الرقم لسه مش متحدد، كلّم صاحب المنصة.' })),
    h('form', { class: 'panel', onsubmit: submit },
      field('عنوان الحساب', 'title', { maxlength: 80, placeholder: 'مثلاً: حساب فيه لاعبين ذهبيين' }),
      field('السعر بالجنيه', 'price', { type: 'number', min: 50, max: 100000, inputmode: 'numeric' }),
      field('وصف الحساب', 'description', { maxlength: 1000, placeholder: 'اللاعبين والمستوى. ممنوع أرقام موبايل أو واتساب أو إيميلات.' }, 'textarea'),
      field('إيميل كونامي', 'email', { maxlength: 120, dir: 'ltr', autocomplete: 'off' }),
      field('كلمة سر كونامي', 'password', { maxlength: 120, dir: 'ltr', autocomplete: 'off' }),
      field('رقم فودافون كاش اللي هتستلم عليه فلوسك', 'payoutPhone', { type: 'tel', inputmode: 'numeric', maxlength: 11, value: me.phone }),
      field('رقم عملية تحويل الرسوم أو آخر 4 أرقام', 'feeRef', { maxlength: 60, dir: 'ltr' }),
      h('button', { class: 'btn', type: 'submit' }, 'ابعت الحساب للعرض'))));
}

const SELLER_SALE = {
  awaiting_payment: 'في مشتري بيدفع دلوقتي', payment_submitted: 'الدفع تحت المراجعة', paid: 'تم الدفع، بنجهز التسليم', delivered: 'اتسلّم للمشتري',
  codes_requested: 'محتاجين منك الأكواد', codes_submitted: 'وصلت الأكواد وبتتمرر للمشتري', codes_relayed: 'المشتري بيغيّر الإيميل',
  email_changed: 'مستنيين تأكيد المشتري', confirmed: 'المشتري أكد. التحويل ليك قريب', paid_out: 'اتحوّلت لك الفلوس', disputed: 'قيد المراجعة',
};
const LISTING_STATUS = { pending_fee: 'مستني تأكيد الرسوم', available: 'معروض في السوق', reserved: 'متحجوز لمشتري', sold: 'اتباع', rejected: 'مرفوض', removed: 'اتشال' };
async function salesPage() {
  if (!me) { location.hash = '#/auth'; return; }
  await poll(() => api('/api/my/listings'), (list) => {
    main.replaceChildren(h('h1', { text: 'مبيعاتي' }), list.length
      ? h('div', { class: 'grid' }, list.map((l) => {
        const s = l.sale;
        const kids = [h('div', { class: 'row' }, h('h3', { text: l.title }), h('span', { class: 'badge', text: LISTING_STATUS[l.status] || l.status })),
          h('span', { class: 'price', text: money(l.price) })];
        if (s) {
          kids.push(h('p', { class: 'muted', text: `هتستلم ${money(s.sellerAmount)} بعد خصم نسبة المنصة (${money(s.commission)}).` }), h('span', { class: 'badge warn', text: SELLER_SALE[s.status] || s.status }));
          if (s.status === 'confirmed' && s.payoutDueAt) kids.push(h('p', { class: 'muted' }, 'التحويل بعد: ', countdown(s.payoutDueAt)));
          if (s.codesNeeded) {
            kids.push(h('form', {
              class: 'note warn stack', onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); act(async () => { await api(`/api/seller/orders/${s.orderId}/codes`, { code1: f.get('code1'), code2: f.get('code2') }); if (refreshFn) await refreshFn(); }, 'وصلت الأكواد'); },
            },
            h('strong', { text: s.codesSubmitted ? 'بعتّ الأكواد. لو ماشتغلتش ابعت جداد:' : 'المشتري محتاج كودين التحقق. ابعتهم:' }),
            field('الكود الأول', 'code1', { maxlength: 12, dir: 'ltr', autocomplete: 'off' }),
            field('الكود التاني', 'code2', { maxlength: 12, dir: 'ltr', autocomplete: 'off' }),
            h('button', { class: 'btn', type: 'submit' }, 'ابعت الأكواد')));
          }
        }
        return h('article', { class: 'card' }, kids);
      }))
      : h('p', { class: 'empty', text: 'لسه ما عرضتش حاجة.' }), h('a', { class: 'btn', href: '#/sell' }, 'اعرض حساب'));
  });
}

// ---------- الدخول ----------
let authMode = 'login';
function auth() {
  if (me) { go('#/'); return; }
  const reg = authMode === 'register';
  const submit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    act(async () => { await api(reg ? '/api/register' : '/api/login', f); go('#/'); });
  };
  main.replaceChildren(h('div', { class: 'panel stack' },
    h('h1', { text: reg ? 'حساب جديد' : 'تسجيل الدخول' }),
    h('form', { onsubmit: submit },
      reg && field('الاسم', 'name', { maxlength: 40 }),
      field('رقم الموبايل', 'phone', { type: 'tel', inputmode: 'numeric', maxlength: 11, placeholder: '01xxxxxxxxx' }),
      field('كلمة السر', 'password', { type: 'password', minlength: reg ? 6 : 1, autocomplete: reg ? 'new-password' : 'current-password' }),
      h('button', { class: 'btn', type: 'submit' }, reg ? 'سجّل' : 'ادخل')),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { authMode = reg ? 'login' : 'register'; auth(); } }, reg ? 'عندي حساب' : 'مستخدم جديد؟ سجّل')));
}

// ---------- لوحة المالك ----------
const ADMIN_STATUS = {
  awaiting_payment: 'مستني دفع المشتري', payment_submitted: 'مستني تأكيدك للتحويل', paid: 'جاهز للتسليم', delivered: 'اتسلّم، المشتري بيشتغل',
  codes_requested: 'المشتري طلب الأكواد', codes_submitted: 'الأكواد عندك، مرّرها', codes_relayed: 'الأكواد عند المشتري', email_changed: 'مستني تأكيد المشتري',
  confirmed: 'مستني التحويل للبائع', paid_out: 'مكتمل', disputed: 'نزاع', refunded: 'اتسترد',
};
async function adminPage() {
  if (!isAdmin) {
    main.replaceChildren(h('div', { class: 'panel stack' }, h('h1', { text: 'لوحة المالك' }),
      h('form', { onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); act(async () => { await api('/api/admin/login', { password: f.get('password') }); go('#/admin'); }); } },
        field('كلمة السر', 'password', { type: 'password', autocomplete: 'current-password' }), h('button', { class: 'btn', type: 'submit' }, 'دخول'))));
    return;
  }
  await poll(() => api('/api/admin/overview'), renderAdmin, 15000);
}
function renderAdmin(d) {
  const nowMs = Date.now();
  const adm = (id, action, msg) => act(async () => { await api(`/api/admin/orders/${id}/${action}`, {}); if (refreshFn) await refreshFn(); }, msg);
  const dueNow = d.orders.filter((o) => o.status === 'confirmed' && o.payoutDueAt <= nowMs);
  document.title = (dueNow.length ? `(${dueNow.length}) ` : '') + BASE_TITLE;

  const orderCard = (o) => {
    const acts = [];
    const btn = (label, action, msg, cls = '') => h('button', { class: 'btn small ' + cls, type: 'button', onclick: () => adm(o.id, action, msg) }, label);
    const rows = [['الحساب', o.title], ['السعر', money(o.price)], ['المشتري', `${o.buyerName} - ${o.buyerPhone}`, true]];
    if (o.payRef) rows.push(['التحويل', `من ${o.payerPhone}، مرجع ${o.payRef}`, true]);
    if (o.status === 'awaiting_payment' || o.status === 'payment_submitted') acts.push(btn('وصلت الفلوس', 'payment-ok', 'اتأكد الدفع'), btn('إلغاء', 'cancel', 'اتلغى', 'danger'));
    if (o.status === 'paid') acts.push(btn('سلّم الحساب للمشتري', 'deliver', 'اتسلّم الحساب'), btn('استرداد', 'refund', 'اتسترد', 'danger'));
    if (o.status === 'codes_requested') {
      acts.push(h('form', {
        class: 'stack', onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); act(async () => { await api(`/api/admin/orders/${o.id}/codes`, { code1: f.get('code1'), code2: f.get('code2') }); if (refreshFn) await refreshFn(); }, 'اتمرّرت للمشتري'); },
      }, h('span', { class: 'muted', text: 'البائع لسه ما بعتش. لو وصلتك الأكواد برّه التطبيق، اكتبها هنا:' }),
      field('الكود الأول', 'code1', { maxlength: 12, dir: 'ltr' }), field('الكود التاني', 'code2', { maxlength: 12, dir: 'ltr' }),
      h('button', { class: 'btn small', type: 'submit' }, 'مرّرها للمشتري')));
    }
    if (o.status === 'codes_submitted') {
      rows.push(['الكود الأول', o.code1, true], ['الكود التاني', o.code2, true]);
      acts.push(btn('مرّرها للمشتري', 'relay', 'اتمرّرت للمشتري'));
    }
    if (o.status === 'codes_relayed') acts.push(btn('المشتري غيّر الإيميل', 'email-changed', 'تمام'));
    if (o.status === 'disputed') { rows.push(['شكوى المشتري', o.disputeNote || 'من غير تفاصيل']); acts.push(btn('الحساب سليم، حرّر التحويل', 'release', 'اتحرر'), btn('استرداد للمشتري', 'refund', 'اتسترد', 'danger')); }
    if (['delivered', 'codes_requested', 'codes_submitted', 'codes_relayed', 'email_changed'].includes(o.status)) acts.push(btn('استرداد', 'refund', 'اتسترد', 'danger'));
    return h('article', { class: 'card' },
      h('div', { class: 'row' }, h('h3', { text: o.title }), h('span', { class: 'badge warn', text: ADMIN_STATUS[o.status] || o.status })),
      kv(rows), h('div', { class: 'row' }, acts));
  };
  const payoutCard = (o) => {
    const ready = o.payoutDueAt <= nowMs;
    return h('article', { class: 'card' },
      h('div', { class: 'row' }, h('h3', { text: o.title }), h('span', { class: ready ? 'badge' : 'badge warn', text: ready ? 'حان وقت التحويل' : 'مستني انتهاء الوقت' })),
      h('p', {}, 'حوّل ', h('strong', { text: money(o.sellerAmount) }), ` للبائع (${o.sellerName}) على فودافون كاش، بعد خصم نسبتك ${money(o.commission)}:`),
      h('div', { class: 'copyline' }, h('span', { class: 'pay', text: o.payoutPhone }), copyBtn(o.payoutPhone)),
      ready ? null : h('p', { class: 'muted' }, 'متاح بعد: ', countdown(o.payoutDueAt)),
      h('button', { class: 'btn small', type: 'button', disabled: !ready, onclick: () => adm(o.id, 'payout', 'اتسجّل التحويل') }, 'تم التحويل للبائع'));
  };
  const group = (title, list, make = orderCard) => (list.length ? [h('h2', { text: title }), h('div', { class: 'grid' }, list.map(make))] : []);
  const by = (...st) => d.orders.filter((o) => st.includes(o.status));

  const pending = d.pendingListings.map((l) => {
    const out = h('span', { class: 'muted' });
    return h('article', { class: 'card' },
      h('div', { class: 'row' }, h('h3', { text: l.title }), h('span', { class: 'price', text: money(l.price) })),
      h('p', { class: 'desc', text: l.description }),
      kv([['البائع', `${l.sellerName} - ${l.sellerPhone}`, true], ['مرجع الرسوم', l.feeRef, true]]), out,
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => act(async () => { await api(`/api/admin/listings/${l.id}/approve`, {}); if (refreshFn) await refreshFn(); }, 'اتعرض الحساب') }, 'وصلت الرسوم، اعرضه'),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => act(async () => { const c = await api(`/api/admin/listings/${l.id}/credentials`); out.textContent = `${c.email} / ${c.password}`; }) }, 'شوف بيانات الحساب'),
        h('button', { class: 'btn danger small', type: 'button', onclick: () => act(async () => { await api(`/api/admin/listings/${l.id}/reject`, {}); if (refreshFn) await refreshFn(); }, 'اترفض') }, 'ارفض')));
  });
  const s = d.stats;
  main.replaceChildren(
    h('h1', { text: 'لوحة المالك' }),
    ...(dueNow.length ? [h('div', { class: 'note warn' }, h('strong', { text: `عندك ${dueNow.length} تحويل مستحق للبائعين دلوقتي.` }), ' شوفهم في قسم "تحويلات للبائعين" تحت.')] : []),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, 'أرباحك', h('b', { text: money(s.commissions + s.fees) })),
      h('div', { class: 'stat' }, `نسبة ${d.settings.commissionPct}%`, h('b', { text: money(s.commissions) })),
      h('div', { class: 'stat' }, 'رسوم العرض', h('b', { text: money(s.fees) })),
      h('div', { class: 'stat' }, 'مستحق للبائعين', h('b', { text: money(s.pendingPayouts) })),
      h('div', { class: 'stat' }, 'حسابات اتباعت', h('b', { text: String(s.sold) }))),
    h('h2', { text: 'رقم استلام الفلوس' }),
    h('form', {
      class: 'panel', onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); act(async () => { await api('/api/admin/config', { vodafoneNumber: f.get('vodafoneNumber') }); if (refreshFn) await refreshFn(); }, 'اتحفظ الرقم'); },
    }, field('رقم فودافون كاش بتاعك (بيظهر للمشترين والبائعين)', 'vodafoneNumber', { type: 'tel', inputmode: 'numeric', maxlength: 11, value: d.config.vodafoneNumber || '' }),
    h('button', { class: 'btn', type: 'submit' }, 'حفظ')),
    ...group('تحويلات للبائعين', by('confirmed'), payoutCard),
    ...(pending.length ? [h('h2', { text: 'حسابات مستنية تأكيد الرسوم' }), h('div', { class: 'grid' }, pending)] : []),
    ...group('مدفوعات تحتاج تأكيدك', by('awaiting_payment', 'payment_submitted')),
    ...group('جاهز للتسليم', by('paid')),
    ...group('الأكواد', by('codes_requested', 'codes_submitted', 'codes_relayed')),
    ...group('نزاعات', by('disputed')),
    ...group('شغالة', by('delivered', 'email_changed')),
    ...group('خلصت', by('paid_out', 'refunded')),
  );
}

router();
