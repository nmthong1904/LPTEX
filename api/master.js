/*******************************************************
 * Vercel Serverless Function: quản lý hệ thống (POST /api/master) - CHỈ tài khoản có claim role = MASTER.
 * Header:  Authorization: Bearer <Firebase ID token>
 * Body:    { action: 'listUsers' | 'createUser' | 'updateUser' | 'setPassword' | 'deleteUser' | 'report', ... }
 * Master chỉ quản lý danh sách tài khoản (user quét thẻ, user quét chay, admin công ty) và xem báo cáo thống kê.
 * Master KHÔNG đọc/sửa dữ liệu nhân viên. Tài khoản master tạo bằng tools/set-role.js (không tạo được qua API).
 * Dùng chung biến môi trường FIREBASE_SERVICE_ACCOUNT với admin.js / recordMeal.js
 *******************************************************/
let db, Timestamp, getAuth;
function init() {
  const app = require('firebase-admin/app');
  const fsx = require('firebase-admin/firestore');
  getAuth = require('firebase-admin/auth').getAuth;
  Timestamp = fsx.Timestamp;
  if (!app.getApps().length) app.initializeApp({ credential: app.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  db = db || fsx.getFirestore();
}

const plain = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().trim();
const fail = (http, message) => Object.assign(new Error(message), { http });

const DOMAIN = '@nhaan.local';
const COMPANIES = ['VITC', 'LPTEX'];
const ROLES = ['user', 'chay', 'admin'];                       // vai trò master được phép gán
const toUser = u => String(u || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');   // giống set-role.js và index.html
const emailOf = u => u + DOMAIN;
const roleOf = c => { const r = plain(c && c.role); return r === 'ADMIN' ? 'admin' : r === 'CHAY' ? 'chay' : r === 'MASTER' ? 'master' : 'user'; };
const claimsFor = (role, company) => role === 'admin' ? { role: 'ADMIN', company } : role === 'chay' ? { role: 'CHAY' } : { role: '' };
const todayVN = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

async function log(master, action, target, detail) {
  try { await db.collection('userLogs').add({ time: Timestamp.now(), master, action, target, detail: detail || '' }); }
  catch (e) { console.error('userLogs', e); }
}

// ---------- tài khoản ----------
async function listUsers() {
  const out = [];
  let tok;
  do {
    const r = await getAuth().listUsers(1000, tok);
    r.users.forEach(u => {
      if (!u.email || !u.email.endsWith(DOMAIN)) return;     // chỉ tài khoản của hệ thống nhà ăn
      const c = u.customClaims || {};
      out.push({
        username: u.email.slice(0, -DOMAIN.length), role: roleOf(c), company: c.company || '',
        disabled: !!u.disabled, created: u.metadata.creationTime || '', lastSignIn: u.metadata.lastSignInTime || ''
      });
    });
    tok = r.pageToken;
  } while (tok);
  return out.sort((a, b) => a.username.localeCompare(b.username));
}

async function getTarget(username) {
  const u = toUser(username);
  if (!u) throw fail(400, 'Thiếu tên tài khoản.');
  try { return await getAuth().getUserByEmail(emailOf(u)); }
  catch (e) { if (e.code === 'auth/user-not-found') throw fail(404, 'Không tìm thấy tài khoản ' + u + '.'); throw e; }
}

function checkRole(role, company) {
  if (!ROLES.includes(role)) throw fail(400, 'Vai trò không hợp lệ.');
  if (role === 'admin' && !COMPANIES.includes(company)) throw fail(400, 'Admin cần chọn công ty (VITC hoặc LPTEX).');
}
const checkPassword = p => { if (String(p || '').length < 6) throw fail(400, 'Mật khẩu tối thiểu 6 ký tự.'); };

async function createUser(d, me) {
  const username = toUser(d.username);
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username)) throw fail(400, 'Tên tài khoản 3-30 ký tự, chỉ gồm chữ thường, số, dấu . _ -');
  const role = String(d.role || ''), company = String(d.company || '').toUpperCase();
  checkRole(role, company); checkPassword(d.password);
  let rec;
  try { rec = await getAuth().createUser({ email: emailOf(username), password: String(d.password), displayName: username }); }
  catch (e) { if (e.code === 'auth/email-already-exists') throw fail(409, 'Tài khoản ' + username + ' đã tồn tại.'); throw e; }
  await getAuth().setCustomUserClaims(rec.uid, claimsFor(role, company));
  await log(me, 'create', username, role + (role === 'admin' ? ' / ' + company : ''));
  return { ok: true };
}

async function updateUser(d, me) {
  const rec = await getTarget(d.username);
  const username = rec.email.slice(0, -DOMAIN.length);
  const c = rec.customClaims || {};
  if (roleOf(c) === 'master') throw fail(403, 'Không sửa được tài khoản master.');
  if (username === me) throw fail(403, 'Không tự sửa tài khoản đang đăng nhập.');
  const role = String(d.role || ''), company = String(d.company || '').toUpperCase(), disabled = !!d.disabled;
  checkRole(role, company);
  await getAuth().updateUser(rec.uid, { disabled });
  await getAuth().setCustomUserClaims(rec.uid, claimsFor(role, company));
  await getAuth().revokeRefreshTokens(rec.uid);                 // quyền mới có hiệu lực ngay, người đó phải đăng nhập lại
  await log(me, 'update', username, role + (role === 'admin' ? ' / ' + company : '') + (disabled ? ' / khóa' : ''));
  return { ok: true };
}

async function setPassword(d, me) {
  const rec = await getTarget(d.username);
  const username = rec.email.slice(0, -DOMAIN.length);
  if (roleOf(rec.customClaims) === 'master' && username !== me) throw fail(403, 'Không đổi mật khẩu của master khác.');
  checkPassword(d.password);
  await getAuth().updateUser(rec.uid, { password: String(d.password) });
  await getAuth().revokeRefreshTokens(rec.uid);
  await log(me, 'password', username);
  return { ok: true, self: username === me };
}

async function deleteUser(d, me) {
  const rec = await getTarget(d.username);
  const username = rec.email.slice(0, -DOMAIN.length);
  if (roleOf(rec.customClaims) === 'master') throw fail(403, 'Không xóa được tài khoản master.');
  if (username === me) throw fail(403, 'Không tự xóa tài khoản đang đăng nhập.');
  await getAuth().deleteUser(rec.uid);
  await log(me, 'delete', username);
  return { ok: true };
}

// ---------- báo cáo thống kê (đọc từ meals, refused) ----------
async function report(d) {
  const from = String(d.from || ''), to = String(d.to || ''), co = String(d.company || '').toUpperCase();
  if (!validDate(from) || !validDate(to)) throw fail(400, 'Ngày không hợp lệ.');
  if (from > to) throw fail(400, 'Ngày bắt đầu phải trước ngày kết thúc.');
  const span = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (span > 92) throw fail(400, 'Chỉ xem tối đa 92 ngày mỗi lần.');
  if (co && !COMPANIES.includes(co)) throw fail(400, 'Công ty không hợp lệ.');

  const snap = await db.collection('meals').where('date', '>=', from).where('date', '<=', to)
    .select('date', 'donVi', 'scanner', 'loai', 'empKey', 'x.CONG_TY').get();

  const days = new Map();
  for (let i = 0; i < span; i++) days.set(new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10), { thuong: 0, chay: 0 });
  const depts = new Map(), scanners = new Map(), companies = new Map(), people = new Set();
  let thuong = 0, chay = 0;
  const bump = (m, key, veg) => { const o = m.get(key) || { thuong: 0, chay: 0 }; o[veg ? 'chay' : 'thuong']++; m.set(key, o); };

  snap.docs.forEach(doc => {
    const company = String(doc.get('x.CONG_TY') || '');
    if (co && !plain(company).startsWith(co)) return;
    const veg = doc.get('loai') === 'chay';
    veg ? chay++ : thuong++;
    people.add(doc.get('empKey'));
    bump(days, doc.get('date'), veg);
    bump(depts, (company || '(Không rõ)') + '||' + (doc.get('donVi') || '(Chưa có đơn vị)'), veg);
    bump(scanners, doc.get('scanner') || '(Không rõ)', veg);
    bump(companies, company || '(Không rõ)', veg);
  });

  let refused = null;                                           // lượt bị từ chối chưa phân theo công ty nên chỉ tính khi xem toàn hệ thống
  if (!co) {
    const t1 = Timestamp.fromMillis(Date.parse(from + 'T00:00:00+07:00'));
    const t2 = Timestamp.fromMillis(Date.parse(to + 'T00:00:00+07:00') + 86400000);
    refused = (await db.collection('refused').where('time', '>=', t1).where('time', '<', t2).count().get()).data().count;
  }

  const arr = (m, f) => [...m].map(([k, v]) => ({ ...f(k), ...v, total: v.thuong + v.chay }));
  return {
    from, to, company: co, total: thuong + chay, thuong, chay, people: people.size, refused,
    byDay: arr(days, k => ({ date: k })),
    byCompany: arr(companies, k => ({ name: k })).sort((a, b) => b.total - a.total),
    byDept: arr(depts, k => { const [company, name] = k.split('||'); return { company, name }; }).sort((a, b) => b.total - a.total),
    byScanner: arr(scanners, k => ({ name: k })).sort((a, b) => b.total - a.total)
  };
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
    if (plain(token.role) !== 'MASTER') return res.status(403).json({ message: 'Tài khoản này không có quyền master.' });

    let d = req.body;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
    d = d || {};
    const me = String(token.email || '').split('@')[0];

    if (d.action === 'listUsers') return res.status(200).json({ me, users: await listUsers() });
    if (d.action === 'createUser') return res.status(200).json(await createUser(d, me));
    if (d.action === 'updateUser') return res.status(200).json(await updateUser(d, me));
    if (d.action === 'setPassword') return res.status(200).json(await setPassword(d, me));
    if (d.action === 'deleteUser') return res.status(200).json(await deleteUser(d, me));
    if (d.action === 'report') return res.status(200).json({ today: todayVN(), ...(await report(d)) });
    return res.status(400).json({ message: 'Hành động không hợp lệ.' });
  } catch (e) {
    console.error('master', e);
    return res.status(e.http || 500).json({ message: e.http ? e.message : 'Lỗi máy chủ: ' + String(e.message || e).slice(0, 200) });
  }
};
