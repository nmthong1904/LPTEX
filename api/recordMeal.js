/*******************************************************
 * Vercel Serverless Function: ghi nhận suất ăn (thay cho Cloud Function recordMeal, không cần gói Blaze)
 * Trang quét gửi POST /api/recordMeal kèm header  Authorization: Bearer <Firebase ID token>
 * Biến môi trường trên Vercel:  FIREBASE_SERVICE_ACCOUNT = nội dung file serviceAccountKey.json (dán nguyên JSON)
 * Dữ liệu Firestore (giống bản cũ):
 *   employees/{key}   cards/{maThe}   lastMeal/{key}   meals/{id}   refused/{id}
 *******************************************************/
// Nạp thư viện lười (lazy) để nếu thiếu thư viện / sai cấu hình thì hàm trả lỗi đọc được, không bị sập
let db, Timestamp, getAuth;
let warmed = false;   // false = lần gọi đầu tiên của máy chủ này (khởi động nguội)
function init() {
  const app = require('firebase-admin/app');
  const fsx = require('firebase-admin/firestore');
  getAuth = require('firebase-admin/auth').getAuth;
  Timestamp = fsx.Timestamp;
  if (!app.getApps().length) {
    app.initializeApp({ credential: app.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  db = db || fsx.getFirestore();
}

const RESET_HOURS = 4;            // sau bao nhiêu giờ thì được nhận lại
const ALLOW_MSNV_CARDS = true;    // còn nhận thẻ cũ in theo MSNV (?msnv=...) không
const EXPIRY_WARN_DAYS = 7;
const TZ = 'Asia/Ho_Chi_Minh';

// ---------- tiện ích ----------
const plain = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().trim();
const safe = s => String(s).trim().replace(/\//g, '_');   // ID tài liệu không được chứa "/"

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});
function parts(ms) {
  const o = {};
  fmt.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  if (o.hour === '24') o.hour = '00';
  return o;
}
const ymd = ms => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const dmy = ms => { const p = parts(ms); return `${p.day}/${p.month}/${p.year}`; };
const hms = ms => { const p = parts(ms); return `${p.hour}:${p.minute}:${p.second}`; };
const hm  = ms => { const p = parts(ms); return `${p.hour}:${p.minute}`; };
const fmtVN = s => { const p = String(s).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(s); };

function empOut(key, e) {
  e = e || {};
  return {
    ok: true, key, msnv: e.msnv || key, sheet: e.sheet || '', hoTen: e.hoTen || '', donVi: e.donVi || '',
    hetHan: e.hetHan || '', trangThai: e.trangThai || '', veg: !!e.veg, x: e.x || {}
  };
}

function eligibility(emp, nowMs) {
  const today = ymd(nowMs);
  const st = plain(emp.trangThai);
  if (st && /KHOA|LOCK|NGHI|MAT THE|THOI VIEC/.test(st)) {
    return { code: 'locked', message: `Thẻ đã bị khóa / nhân viên đã nghỉ (${emp.trangThai}). Không cấp suất ăn.` };
  }
  const h = String(emp.hetHan || '');
  if (h.startsWith('INVALID:')) {
    return { code: 'badDate', message: `Ngày hết hạn hợp đồng không đọc được (${h.slice(8)}). Vui lòng liên hệ quản lý.` };
  }
  if (h && h < today) {
    return { code: 'expired', message: `Hợp đồng đã hết hạn ngày ${fmtVN(h)}. Không cấp suất ăn.` };
  }
  return null;
}

function expiryNote(emp, nowMs) {
  const h = String(emp.hetHan || '');
  if (!h || h.startsWith('INVALID:')) return '';
  const today = ymd(nowMs);
  if (h < today) return '';
  const days = Math.round((Date.parse(h + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  if (days > EXPIRY_WARN_DAYS) return '';
  return `Hợp đồng hết hạn ngày ${fmtVN(h)}` + (days === 0 ? ' (HẾT HẠN HÔM NAY)' : ` (còn ${days} ngày)`);
}

async function logRefused(emp, message, scanner) {
  try {
    await db.collection('refused').add({
      time: Timestamp.now(), msnv: emp.msnv || '', hoTen: emp.hoTen || '', donVi: emp.donVi || '',
      lyDo: message, scanner: scanner || ''
    });
  } catch (e) { console.error('logRefused', e); }
}

// ---------- xử lý chính ----------
async function recordMeal(token, data) {
  if (data.ping) return { ok: true, ping: true };      // trang quét gọi định kỳ để giữ hàm "nóng"

  const vegMode = plain(token.role) === 'CHAY';
  const username = String(token.email || '').split('@')[0];
  const name = String(token.name || '').trim();
  const scanner = name && name !== username ? `${name} (${username})` : username;

  const the = String(data.the || '').trim().toUpperCase();
  const msnv = String(data.msnv || '').trim();
  if (!the && !msnv) return { ok: false, message: 'QR không chứa mã thẻ.' };

  // 1) Tìm nhân viên
  let key;
  if (the) {
    if (!/^[A-Z0-9_-]{4,40}$/.test(the)) {
      const message = `Không tìm thấy thẻ có mã: ${the}`;
      await logRefused({}, `${message} [${the}]`, scanner);
      return { ok: false, notFound: true, message };
    }
    const c = await db.doc(`cards/${the}`).get();
    if (!c.exists) {
      const message = `Không tìm thấy thẻ có mã: ${the}`;
      await logRefused({}, `${message} [${the}]`, scanner);
      return { ok: false, notFound: true, message };
    }
    const cd = c.data();
    if (cd.revoked) {
      const message = 'Thẻ này đã bị thu hồi (mất hoặc đã thay thẻ mới). Không cấp suất ăn.';
      const employee = empOut(cd.msnv, { msnv: cd.msnv, hoTen: cd.hoTen });
      await logRefused(employee, `${message} [${the}]`, scanner);
      return { ok: false, blocked: true, reason: 'revoked', message, employee };
    }
    key = cd.key;
  } else {
    key = safe(msnv);
    if (!ALLOW_MSNV_CARDS) {
      const message = 'Thẻ cũ (mã theo MSNV) không còn được chấp nhận. Vui lòng đổi thẻ mới.';
      await logRefused({ msnv }, message, scanner);
      return { ok: false, blocked: true, reason: 'legacy', message };
    }
  }

  const es = await db.doc(`employees/${key}`).get();
  if (!es.exists) {
    return { ok: false, notFound: true,
      message: the ? `Không tìm thấy nhân viên cho thẻ: ${the}` : `Không tìm thấy nhân viên có MSNV: ${msnv}` };
  }
  const e = es.data();
  const emp = empOut(key, e);

  if (!the && e.legacyRevoked) {
    const message = 'Thẻ cũ đã được thay bằng thẻ mới. Không cấp suất ăn.';
    await logRefused(emp, message, scanner);
    return { ok: false, blocked: true, reason: 'oldcard', message, employee: emp };
  }

  // 2) Hợp đồng / trạng thái
  const nowMs = Date.now();
  const block = eligibility(emp, nowMs);
  if (block) {
    await logRefused(emp, block.message, scanner);
    return { ok: false, blocked: true, reason: block.code, message: block.message, employee: emp };
  }

  // 3) Tài khoản quét suất chay: chỉ nhân viên đã đăng ký chay
  if (vegMode && !emp.veg) {
    const message = 'Nhân viên chưa đăng ký ăn chay. Không cấp suất ăn chay.';
    await logRefused(emp, message, scanner);
    return { ok: false, blocked: true, reason: 'notveg', message, employee: emp };
  }

  // 4) Kiểm tra trùng + ghi, trong 1 transaction (chỉ khóa đúng nhân viên này)
  const RESET_MS = RESET_HOURS * 3600 * 1000;
  const lastRef = db.doc(`lastMeal/${key}`);
  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(lastRef);
    const now = Date.now();
    if (snap.exists && now - snap.data().time < RESET_MS) {
      return { dup: true, last: snap.data().time, now };
    }
    tx.set(lastRef, { time: now });
    tx.create(db.collection('meals').doc(), {
      time: Timestamp.fromMillis(now), date: ymd(now), empKey: key, msnv: emp.msnv,
      hoTen: emp.hoTen, donVi: emp.donVi, trangThai: 'ĐÃ NHẬN', scanner,
      loai: vegMode ? 'chay' : 'thuong', x: emp.x || {}
    });
    return { dup: false, now };
  });

  if (out.dup) {
    const last = out.last;
    const sameDay = ymd(last) === ymd(out.now);
    return {
      ok: false, duplicate: true,
      message: `Nhân viên này đã lấy suất ăn lúc ${hms(last)}` + (sameDay ? '' : ` ngày ${dmy(last)}`) + '.',
      time: `${hms(last)} ${dmy(last)}`,
      next: `${hm(last + RESET_MS)} ${dmy(last + RESET_MS)}`,
      employee: emp
    };
  }

  const exp = expiryNote(emp, out.now);
  return {
    ok: true,
    message: 'Đã ghi nhận suất ăn thành công.',
    time: `${dmy(out.now)} ${hms(out.now)}`,
    note: (vegMode ? 'SUẤT ĂN CHAY' : '') + (vegMode && exp ? ' | ' : '') + exp,
    employee: emp
  };
}

const errText = e => String((e && (e.code || '') + ' ' + (e.message || e))).trim().slice(0, 300);

// GET /api/recordMeal?diag=1 : báo tình trạng hàm (không lộ khóa) - chỉ dùng khi chẩn đoán
async function diag() {
  const out = { node: process.version, region: process.env.VERCEL_REGION || '', envPresent: !!process.env.FIREBASE_SERVICE_ACCOUNT };
  try { require('firebase-admin/app'); out.adminLoad = 'ok'; } catch (e) { out.adminLoad = errText(e); }
  try {
    const j = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    out.envParse = 'ok'; out.projectId = j.project_id || '(thiếu project_id)';
    out.hasPrivateKey = !!(j.private_key && j.private_key.includes('BEGIN PRIVATE KEY'));
  } catch (e) { out.envParse = errText(e); }
  try { init(); const c = await db.doc('cards/NEK37UJCDW').get(); out.firestore = c.exists ? 'ok (đọc được thẻ mẫu)' : 'ok nhưng không thấy thẻ mẫu'; }
  catch (e) { out.firestore = errText(e); }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const t0 = Date.now();
  try {
    if (req.method === 'GET' && req.query && req.query.diag) return res.status(200).json(await diag());
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ error: 'unauthenticated' });
    try { init(); } catch (e) {
      console.error('init', e);
      return res.status(500).json({ error: 'server', detail: 'init: ' + errText(e) });
    }
    let token;
    try { token = await getAuth().verifyIdToken(m[1]); }
    catch (e) { console.error('verifyIdToken', e && e.message); return res.status(401).json({ error: 'unauthenticated' }); }
    const t1 = Date.now();   // xong bước nạp thư viện + xác thực
    let data = req.body;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
    const out = await recordMeal(token, data || {});
    out.t = { auth: t1 - t0, logic: Date.now() - t1, cold: !warmed };   // ms, trang quét dùng để hiển thị tốc độ
    warmed = true;
    return res.status(200).json(out);
  } catch (e) {
    console.error('recordMeal', e);
    return res.status(500).json({ error: 'server', detail: errText(e) });
  }
};