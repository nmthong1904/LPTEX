/*******************************************************
 * Nhập dữ liệu xuất từ Google Sheets (firebase_export.json) vào Firestore + Authentication.
 * Cách dùng (trong thư mục tools):
 *   npm install
 *   node import.js firebase_export.json                      (nhập tất cả)
 *   node import.js firebase_export.json --only=employees     (chỉ nhân viên + thẻ; chạy lại bao nhiêu lần cũng được)
 *   node import.js firebase_export.json --only=users         (tài khoản quét; xem ghi chú bên dưới)
 *   node import.js firebase_export.json --only=history       (lịch sử; chạy lại không bị nhân đôi)
 * Cần file serviceAccountKey.json (Firebase Console > Project settings > Service accounts > Generate new private key)
 * đặt cạnh file này. Mật khẩu mặc định cho tài khoản không đọc được mật khẩu: biến môi trường DEFAULT_PW (mặc định 123456).
 * LƯU Ý: chạy lại --only=users sẽ đặt lại mật khẩu về giá trị trong file xuất / DEFAULT_PW.
 *******************************************************/
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const onlyArg = args.find(a => a.startsWith('--only='));
const only = (onlyArg ? onlyArg.slice(7) : 'employees,users,history').split(',');
const DEFAULT_PW = process.env.DEFAULT_PW || '123456';

if (!file) {
  console.log('Cách dùng: node import.js firebase_export.json [--only=employees,users,history]');
  process.exit(1);
}

// Tìm file khóa: ưu tiên serviceAccountKey.json, nếu không có thì lấy file *-firebase-adminsdk-*.json tải từ Firebase
let keyFile = path.resolve(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(keyFile)) {
  const found = fs.readdirSync(__dirname).filter(f => /firebase-adminsdk.*\.json$/i.test(f));
  if (found.length === 1) keyFile = path.resolve(__dirname, found[0]);
  else {
    console.error('Không tìm thấy serviceAccountKey.json (hoặc file *-firebase-adminsdk-*.json) trong thư mục tools.');
    process.exit(1);
  }
}
const serviceAccount = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
console.log('Project:', serviceAccount.project_id);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const auth = getAuth();

const safe = s => String(s).trim().replace(/\//g, '_');
const plain = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().trim();
const toUser = u => String(u).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');   // phải giống hàm toEmail trong index.html

(async () => {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bw = db.bulkWriter();
  bw.onWriteError(err => {
    if (err.failedAttempts < 5) return true;
    console.error('Lỗi ghi', err.documentRef.path, err.message);
    return false;
  });

  if (only.includes('employees')) {
    // Thẻ cũ in theo MSNV đã bị thu hồi: đánh dấu trên nhân viên
    const legacy = new Set();
    Object.keys(d.revoked || {}).forEach(code => {
      const r = d.revoked[code];
      if (code.indexOf('MSNV:') === 0) legacy.add(safe(r.msnv));
      else bw.set(db.doc(`cards/${code}`), { revoked: true, msnv: r.msnv || '', hoTen: r.hoTen || '', lyDo: r.lyDo || '' });
    });
    let nEmp = 0, nCard = 0;
    for (const e of d.employees) {
      const key = safe(e.key);
      bw.set(db.doc(`employees/${key}`), {
        msnv: e.msnv, sheet: e.sheet, hoTen: e.hoTen, donVi: e.donVi, hetHan: e.hetHan || '',
        trangThai: e.trangThai || '', veg: !!e.veg, x: e.x || {}, legacyRevoked: legacy.has(key)
      });
      nEmp++;
      if (e.the) { bw.set(db.doc(`cards/${e.the}`), { key }); nCard++; }
    }
    console.log(`Nhân viên: ${nEmp}, thẻ đang dùng: ${nCard}, thẻ đã thu hồi: ${Object.keys(d.revoked || {}).filter(c => c.indexOf('MSNV:') !== 0).length}`);
  }

  if (only.includes('history')) {
    const lastByKey = {};
    for (const m of d.meals || []) {
      const key = safe(m.key);
      bw.set(db.doc(`meals/${m.time}_${key}`), {
        time: Timestamp.fromMillis(m.time), date: m.date, empKey: key, msnv: m.key, hoTen: m.hoTen, donVi: m.donVi,
        trangThai: m.trangThai || 'ĐÃ NHẬN', scanner: m.scanner || '', loai: 'thuong', x: m.x || {}
      });
      if (!lastByKey[key] || m.time > lastByKey[key]) lastByKey[key] = m.time;
    }
    Object.keys(lastByKey).forEach(k => bw.set(db.doc(`lastMeal/${k}`), { time: lastByKey[k] }));
    (d.refused || []).forEach((r, i) => {
      bw.set(db.doc(`refused/${r.time}_${i}`), {
        time: Timestamp.fromMillis(r.time), msnv: r.msnv || '', hoTen: r.hoTen || '', donVi: r.donVi || '',
        lyDo: r.lyDo || '', scanner: r.scanner || ''
      });
    });
    console.log(`Lịch sử: ${(d.meals || []).length} lượt nhận, ${(d.refused || []).length} lượt từ chối`);
  }

  await bw.close();

  if (only.includes('users')) {
    for (const u of d.users || []) {
      const uname = toUser(u.username);
      if (!uname) { console.log('Bỏ qua tài khoản tên lạ:', u.username); continue; }
      const email = `${uname}@nhaan.local`;
      const hasPw = u.password && u.password.length >= 6;
      const pw = hasPw ? u.password : DEFAULT_PW;
      const disabled = /KHOA|LOCK|NGHI/.test(plain(u.trangThai));
      const props = { displayName: u.hoTen || uname, disabled, password: pw };
      let rec;
      try {
        rec = await auth.getUserByEmail(email);
        await auth.updateUser(rec.uid, props);
      } catch (e) {
        if (e.code === 'auth/user-not-found') rec = await auth.createUser(Object.assign({ email }, props));
        else throw e;
      }
      const old = rec.customClaims || {};
      const keepAdmin = String(old.role || '').toUpperCase() === 'ADMIN';   // không làm mất quyền admin + công ty khi nhập lại
      await auth.setCustomUserClaims(rec.uid, keepAdmin ? { role: 'ADMIN', company: old.company || '' } : { role: plain(u.loaiSuat) === 'CHAY' ? 'CHAY' : '' });
      console.log(`Tài khoản ${uname}: ${disabled ? 'ĐANG KHÓA, ' : ''}${plain(u.loaiSuat) === 'CHAY' ? 'quét suất chay, ' : ''}mật khẩu ${hasPw ? 'lấy từ sheet' : 'mặc định ' + DEFAULT_PW}`);
    }
  }
  console.log('XONG.');
})().catch(e => { console.error(e); process.exit(1); });