/*******************************************************
 * Vercel Serverless Function: quản trị nhà ăn (POST /api/admin) - CHỈ tài khoản có claim role = ADMIN.
 * Header:  Authorization: Bearer <Firebase ID token>
 * Body:    { action: 'departments' | 'byDept' | 'search' | 'detail' | 'reissue', ... }
 * Phân quyền: claim role = ADMIN và claim company = VITC | LPTEX (chỉ thấy nhân viên công ty mình)
 * Dùng chung biến môi trường FIREBASE_SERVICE_ACCOUNT với recordMeal.js
 *******************************************************/
const crypto = require('crypto');
let db, Timestamp, getAuth;
function init() {
  const app = require('firebase-admin/app');
  const fsx = require('firebase-admin/firestore');
  getAuth = require('firebase-admin/auth').getAuth;
  Timestamp = fsx.Timestamp;
  if (!app.getApps().length) app.initializeApp({ credential: app.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  db = db || fsx.getFirestore();
}

const plain = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().trim();
const safe = s => String(s).trim().replace(/\//g, '_');
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 10 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const fail = (http, message) => Object.assign(new Error(message), { http });

// Mỗi tài khoản admin chỉ được thao tác trên nhân viên của công ty mình.
// Claim `company` của tài khoản (VITC | LPTEX) khớp với trường employees.sheet.
const COMPANIES = { VITC: 'VITC Garment', LPTEX: 'LPTEX' };
const inScope = (scope, e) => plain(e.sheet) === scope;
const deptCache = {};   // { [scope]: { at, list } } - danh sách phòng ban giữ 5 phút để đỡ đọc Firestore

const empOut = (key, e) => ({
  key, msnv: e.msnv || key, hoTen: e.hoTen || '', donVi: e.donVi || '', sheet: e.sheet || '',
  congTy: (e.x && e.x.CONG_TY) || '', hetHan: e.hetHan || '', trangThai: e.trangThai || '', veg: !!e.veg
});

async function search(q, scope) {
  q = String(q || '').trim();
  if (!q) return [];
  const found = new Map();
  const addDoc = d => { if (d.exists) found.set(d.id, d.data()); };
  const addQuery = s => s.docs.forEach(d => found.set(d.id, d.data()));
  const up = q.toUpperCase();
  try {
    if (/^[A-Z0-9_-]{4,40}$/.test(up)) {                       // mã thẻ
      const c = await db.doc(`cards/${up}`).get();
      if (c.exists && c.data().key) addDoc(await db.doc(`employees/${c.data().key}`).get());
    }
    addDoc(await db.doc(`employees/${safe(q)}`).get());          // khóa nhân viên (vd 1669 hoặc LPTEX:8)
  } catch (e) { /* id không hợp lệ: bỏ qua */ }
  addQuery(await db.collection('employees').where('msnv', '==', q).limit(10).get());
  if (!found.size) {                                             // họ tên: tìm theo phần đầu, phải gõ đúng dấu
    for (const s of new Set([q, up])) {
      addQuery(await db.collection('employees').where('hoTen', '>=', s).where('hoTen', '<=', s + '\uf8ff').limit(50).get());
    }
  }
  return [...found].filter(([, e]) => inScope(scope, e)).slice(0, 20).map(([key, e]) => empOut(key, e));
}

async function departments(scope) {
  const c = deptCache[scope];
  if (c && Date.now() - c.at < 300000) return c.list;
  const snap = await db.collection('employees').where('sheet', '==', scope).select('donVi').get();
  const m = new Map();
  snap.docs.forEach(d => { const n = d.get('donVi') || ''; m.set(n, (m.get(n) || 0) + 1); });
  const list = [...m].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  deptCache[scope] = { at: Date.now(), list };
  return list;
}

async function byDept(scope, dept) {
  const snap = await db.collection('employees').where('sheet', '==', scope).where('donVi', '==', String(dept || '')).get();
  return snap.docs.map(d => empOut(d.id, d.data())).sort((a, b) => String(a.hoTen).localeCompare(String(b.hoTen), 'vi'));
}

async function detail(key, scope) {
  const es = await db.doc(`employees/${safe(key)}`).get();
  if (!es.exists) throw fail(404, 'Không tìm thấy nhân viên.');
  const e = es.data();
  if (!inScope(scope, e)) throw fail(403, 'Nhân viên này thuộc công ty khác, tài khoản của bạn không có quyền.');
  const [byKey, byMsnv, last] = await Promise.all([
    db.collection('cards').where('key', '==', es.id).get(),
    db.collection('cards').where('msnv', '==', String(e.msnv || '')).get(),
    db.doc(`lastMeal/${es.id}`).get()
  ]);
  const cards = new Map();
  byKey.docs.forEach(d => cards.set(d.id, d.data()));
  // thẻ cũ nhập từ Google Sheets đã thu hồi không có "key": ghép theo MSNV + họ tên
  byMsnv.docs.forEach(d => {
    const c = d.data();
    if (!cards.has(d.id) && c.revoked && (c.hoTen || '') === (e.hoTen || '')) cards.set(d.id, c);
  });
  const cardList = [...cards].map(([code, c]) => ({
    code, revoked: !!c.revoked, lyDo: c.lyDo || '',
    at: (c.revokedAt || c.issuedAt || null) && (c.revokedAt || c.issuedAt).toMillis()
  })).sort((a, b) => a.revoked - b.revoked || (b.at || 0) - (a.at || 0));

  let snap;
  try { snap = await db.collection('meals').where('empKey', '==', es.id).orderBy('time', 'desc').limit(10).get(); }
  catch (err) { snap = await db.collection('meals').where('empKey', '==', es.id).limit(300).get(); }   // chưa tạo index
  const meals = snap.docs.map(d => d.data()).sort((a, b) => b.time.toMillis() - a.time.toMillis()).slice(0, 10)
    .map(m => ({ time: m.time.toMillis(), loai: m.loai || 'thuong', scanner: m.scanner || '' }));

  return { employee: empOut(es.id, e), cards: cardList, meals, lastMeal: last.exists ? last.data().time : null };
}

async function reissue(key, reason, adminName, scope) {
  const es = await db.doc(`employees/${safe(key)}`).get();
  if (!es.exists) throw fail(404, 'Không tìm thấy nhân viên.');
  const e = es.data();
  if (!inScope(scope, e)) throw fail(403, 'Nhân viên này thuộc công ty khác, tài khoản của bạn không có quyền.');
  const old = (await db.collection('cards').where('key', '==', es.id).get()).docs.filter(d => !d.data().revoked).map(d => d.id);
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    const c = newCode();
    if (!(await db.doc(`cards/${c}`).get()).exists) code = c;
  }
  if (!code) throw fail(500, 'Không tạo được mã thẻ mới, hãy thử lại.');

  const st = plain(e.trangThai);
  const clearStatus = /MAT THE/.test(st);          // trạng thái "MẤT THẺ" sẽ chặn cả thẻ mới
  const stillBlocked = !!st && !clearStatus && /KHOA|LOCK|NGHI|THOI VIEC/.test(st);
  const now = Timestamp.now();
  reason = String(reason || '').trim().slice(0, 200) || 'Mất thẻ / đã cấp lại thẻ mới';

  const batch = db.batch();
  old.forEach(c => batch.set(db.doc(`cards/${c}`), {
    revoked: true, key: es.id, msnv: e.msnv || '', hoTen: e.hoTen || '', lyDo: reason, revokedAt: now
  }));
  batch.set(db.doc(`cards/${code}`), { key: es.id, issuedAt: now });
  if (clearStatus) batch.update(es.ref, { trangThai: '' });
  batch.create(db.collection('cardLogs').doc(), {
    time: now, empKey: es.id, msnv: e.msnv || '', hoTen: e.hoTen || '', oldCodes: old, newCode: code, lyDo: reason, admin: adminName, company: scope
  });
  await batch.commit();
  return { newCode: code, oldCodes: old, clearStatus, stillBlocked, employee: empOut(es.id, { ...e, trangThai: clearStatus ? '' : e.trangThai }) };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ message: 'method' });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return res.status(401).json({ message: 'Chưa đăng nhập.' });
    init();
    let token;
    try { token = await getAuth().verifyIdToken(m[1]); }
    catch (e) { return res.status(401).json({ message: 'Hết phiên đăng nhập.' }); }
    if (plain(token.role) !== 'ADMIN') return res.status(403).json({ message: 'Tài khoản này không có quyền quản trị.' });

    const scope = plain(token.company);
    if (!COMPANIES[scope]) return res.status(403).json({ message: 'Tài khoản quản trị chưa được gán công ty (VITC hoặc LPTEX).' });

    let d = req.body;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
    d = d || {};
    const adminName = String(token.email || '').split('@')[0];

    if (d.action === 'departments') return res.status(200).json({ company: COMPANIES[scope], departments: await departments(scope) });
    if (d.action === 'byDept') return res.status(200).json({ results: await byDept(scope, d.dept) });
    if (d.action === 'search') return res.status(200).json({ results: await search(d.q, scope) });
    if (d.action === 'detail') return res.status(200).json(await detail(d.key, scope));
    if (d.action === 'reissue') return res.status(200).json(await reissue(d.key, d.reason, adminName, scope));
    return res.status(400).json({ message: 'Hành động không hợp lệ.' });
  } catch (e) {
    console.error('admin', e);
    return res.status(e.http || 500).json({ message: e.http ? e.message : 'Lỗi máy chủ: ' + String(e.message || e).slice(0, 200) });
  }
};
