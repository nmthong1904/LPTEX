/*******************************************************
 * Vercel Serverless Function: quản trị nhà ăn (POST /api/admin) - CHỈ tài khoản có claim role = ADMIN.
 * Header:  Authorization: Bearer <Firebase ID token>
 * Body:    { action: 'departments' | 'byDept' | 'search' | 'detail' | 'reprint' | 'reissue' | 'create' | 'update' | 'delete' | 'setVeg' | 'setVegBulk', ... }
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

// Giờ Việt Nam (UTC+7, không có giờ mùa hè): ngày hôm nay dạng YYYY-MM-DD
const todayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

const empOut = (key, e) => ({
  key, msnv: e.msnv || key, hoTen: e.hoTen || '', donVi: e.donVi || '', sheet: e.sheet || '',
  congTy: (e.x && e.x.CONG_TY) || '', hetHan: e.hetHan || '', trangThai: e.trangThai || '',
  vegDates: (Array.isArray(e.vegDates) ? e.vegDates : []).filter(d => d >= todayVN()).sort()   // các ngày đã đăng ký ăn chay (từ hôm nay)
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

  return { today: todayVN(), employee: empOut(es.id, e), cards: cardList, meals, lastMeal: last.exists ? last.data().time : null };
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
    time: now, empKey: es.id, msnv: e.msnv || '', hoTen: e.hoTen || '', action: 'reissue', oldCodes: old, newCode: code, lyDo: reason, admin: adminName, company: scope
  });
  await batch.commit();
  return { newCode: code, oldCodes: old, clearStatus, stillBlocked, employee: empOut(es.id, { ...e, trangThai: clearStatus ? '' : e.trangThai }) };
}

// ---------- in lại thẻ (giữ nguyên mã thẻ, chỉ ghi nhật ký) ----------
async function getScoped(key, scope) {
  const es = await db.doc(`employees/${safe(key)}`).get();
  if (!es.exists) throw fail(404, 'Không tìm thấy nhân viên.');
  if (!inScope(scope, es.data())) throw fail(403, 'Nhân viên này thuộc công ty khác, tài khoản của bạn không có quyền.');
  return es;
}

async function reprint(key, scope, adminName) {
  const es = await getScoped(key, scope);
  const e = es.data();
  const active = (await db.collection('cards').where('key', '==', es.id).get()).docs.filter(d => !d.data().revoked);
  if (!active.length) throw fail(404, 'Nhân viên chưa có thẻ đang dùng. Hãy bấm "Cấp lại thẻ".');
  active.sort((a, b) => ((b.data().issuedAt && b.data().issuedAt.toMillis()) || 0) - ((a.data().issuedAt && a.data().issuedAt.toMillis()) || 0));
  const code = active[0].id;
  await db.collection('cardLogs').add({
    time: Timestamp.now(), action: 'reprint', empKey: es.id, msnv: e.msnv || '', hoTen: e.hoTen || '', newCode: code, admin: adminName, company: scope
  });
  return { code, employee: empOut(es.id, e) };
}

// ---------- thêm / sửa / xóa nhân viên (chỉ trong công ty của tài khoản) ----------
const STATUSES = ['', 'Khóa thẻ', 'Nghỉ việc'];   // "MẤT THẺ" do chức năng cấp lại thẻ tự xóa
const snapshot = e => ({ msnv: e.msnv || '', hoTen: e.hoTen || '', donVi: e.donVi || '', hetHan: e.hetHan || '', trangThai: e.trangThai || '' });

function cleanEmp(d, current) {
  const s = v => String(v == null ? '' : v).trim();
  const f = { hoTen: s(d.hoTen).slice(0, 100), donVi: s(d.donVi).slice(0, 100), hetHan: s(d.hetHan), trangThai: s(d.trangThai) };
  if (!f.hoTen) throw fail(400, 'Họ tên không được để trống.');
  if (!f.donVi) throw fail(400, 'Phòng ban không được để trống.');
  if (f.hetHan && !validDate(f.hetHan)) throw fail(400, 'Ngày hết hạn hợp đồng không hợp lệ.');
  if (!STATUSES.includes(f.trangThai) && !(current && f.trangThai === current.trangThai)) throw fail(400, 'Trạng thái không hợp lệ.');
  return f;
}

async function createEmp(d, scope, adminName) {
  const msnv = String(d.msnv || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(msnv)) throw fail(400, 'MSNV chỉ gồm chữ, số, dấu . _ - (tối đa 20 ký tự).');
  const f = cleanEmp(d);
  const dup = await db.collection('employees').where('sheet', '==', scope).where('msnv', '==', msnv).limit(1).get();
  if (!dup.empty) throw fail(409, `MSNV ${msnv} đã có trong công ty.`);
  // khóa = MSNV; nếu công ty kia đã dùng MSNV này thì khóa dạng LPTEX:8 (giống dữ liệu nhập từ Google Sheets)
  const key = (await db.doc(`employees/${msnv}`).get()).exists ? `${scope}:${msnv}` : msnv;
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    const c = newCode();
    if (!(await db.doc(`cards/${c}`).get()).exists) code = c;
  }
  if (!code) throw fail(500, 'Không tạo được mã thẻ mới, hãy thử lại.');
  const now = Timestamp.now();
  const emp = { msnv, sheet: scope, ...f, x: { CONG_TY: COMPANIES[scope] }, legacyRevoked: false };
  const batch = db.batch();
  batch.create(db.doc(`employees/${key}`), emp);
  batch.set(db.doc(`cards/${code}`), { key, issuedAt: now });
  batch.create(db.collection('empLogs').doc(), { time: now, action: 'create', empKey: key, after: snapshot(emp), newCode: code, admin: adminName, company: scope });
  await batch.commit();
  delete deptCache[scope];
  return { employee: empOut(key, emp), newCode: code };
}

async function updateEmp(d, scope, adminName) {
  const es = await getScoped(d.key, scope);
  const e = es.data();
  const f = cleanEmp(d, e);                     // MSNV và công ty không đổi được
  const batch = db.batch();
  batch.update(es.ref, f);
  batch.create(db.collection('empLogs').doc(), { time: Timestamp.now(), action: 'update', empKey: es.id, before: snapshot(e), after: snapshot({ ...e, ...f }), admin: adminName, company: scope });
  await batch.commit();
  delete deptCache[scope];
  return { employee: empOut(es.id, { ...e, ...f }) };
}

async function removeEmp(key, scope, adminName) {
  const es = await getScoped(key, scope);
  const e = es.data();
  const now = Timestamp.now();
  const cards = (await db.collection('cards').where('key', '==', es.id).get()).docs.filter(d => !d.data().revoked);
  const batch = db.batch();
  cards.forEach(c => batch.set(c.ref, { revoked: true, key: es.id, msnv: e.msnv || '', hoTen: e.hoTen || '', lyDo: 'Đã xóa nhân viên', revokedAt: now }));
  batch.delete(es.ref);                         // lịch sử nhận suất (meals) được giữ nguyên
  batch.create(db.collection('empLogs').doc(), { time: now, action: 'delete', empKey: es.id, before: snapshot(e), revokedCodes: cards.map(c => c.id), admin: adminName, company: scope });
  await batch.commit();
  delete deptCache[scope];
  return { ok: true };
}

// ---------- đăng ký ăn chay theo ngày ----------
function checkVegDate(date) {
  const today = todayVN();
  if (!validDate(date)) throw fail(400, 'Ngày không hợp lệ.');
  if (date < today) throw fail(400, 'Không đăng ký cho ngày đã qua.');
  if (date > new Date(Date.parse(today) + 60 * 86400000).toISOString().slice(0, 10)) throw fail(400, 'Chỉ đăng ký trước tối đa 60 ngày.');
  return today;
}

async function setVeg(d, scope, adminName) {
  const es = await getScoped(d.key, scope);
  const e = es.data();
  const date = String(d.date || '').trim(), today = checkVegDate(date);
  const list = (Array.isArray(e.vegDates) ? e.vegDates : []).filter(x => x >= today && x !== date);   // bỏ luôn các ngày đã qua
  if (d.veg) list.push(date);
  list.sort();
  const batch = db.batch();
  batch.update(es.ref, { vegDates: list });
  batch.create(db.collection('empLogs').doc(), { time: Timestamp.now(), action: d.veg ? 'vegOn' : 'vegOff', empKey: es.id, date, admin: adminName, company: scope });
  await batch.commit();
  return { employee: empOut(es.id, { ...e, vegDates: list }) };
}

// nhiều nhân viên cùng lúc (chọn trong một phòng ban): một lần ghi, một dòng nhật ký
async function setVegBulk(d, scope, adminName) {
  const date = String(d.date || '').trim(), today = checkVegDate(date);
  const keys = [...new Set((Array.isArray(d.keys) ? d.keys : []).map(k => String(k)))];
  if (!keys.length) throw fail(400, 'Chưa chọn nhân viên nào.');
  if (keys.length > 200) throw fail(400, 'Chỉ chọn tối đa 200 nhân viên mỗi lần.');
  const snaps = await db.getAll(...keys.map(k => db.doc(`employees/${safe(k)}`)));
  if (snaps.some(x => !x.exists || !inScope(scope, x.data()))) throw fail(403, 'Có nhân viên không tồn tại hoặc thuộc công ty khác.');
  const batch = db.batch();
  snaps.forEach(es => {
    const cur = es.data().vegDates;
    const list = (Array.isArray(cur) ? cur : []).filter(x => x >= today && x !== date);
    if (d.veg) list.push(date);
    batch.update(es.ref, { vegDates: list.sort() });
  });
  batch.create(db.collection('empLogs').doc(), { time: Timestamp.now(), action: d.veg ? 'vegOnBulk' : 'vegOffBulk', date, empKeys: snaps.map(x => x.id), admin: adminName, company: scope });
  await batch.commit();
  return { count: snaps.length, date };
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

    if (d.action === 'departments') return res.status(200).json({ company: COMPANIES[scope], today: todayVN(), departments: await departments(scope) });
    if (d.action === 'byDept') return res.status(200).json({ results: await byDept(scope, d.dept) });
    if (d.action === 'search') return res.status(200).json({ results: await search(d.q, scope) });
    if (d.action === 'detail') return res.status(200).json(await detail(d.key, scope));
    if (d.action === 'reprint') return res.status(200).json(await reprint(d.key, scope, adminName));
    if (d.action === 'create') return res.status(200).json(await createEmp(d, scope, adminName));
    if (d.action === 'update') return res.status(200).json(await updateEmp(d, scope, adminName));
    if (d.action === 'delete') return res.status(200).json(await removeEmp(d.key, scope, adminName));
    if (d.action === 'setVegBulk') return res.status(200).json(await setVegBulk(d, scope, adminName));
    if (d.action === 'setVeg') return res.status(200).json(await setVeg(d, scope, adminName));
    if (d.action === 'reissue') return res.status(200).json(await reissue(d.key, d.reason, adminName, scope));
    return res.status(400).json({ message: 'Hành động không hợp lệ.' });
  } catch (e) {
    console.error('admin', e);
    return res.status(e.http || 500).json({ message: e.http ? e.message : 'Lỗi máy chủ: ' + String(e.message || e).slice(0, 200) });
  }
};