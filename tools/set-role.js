/*******************************************************
 * Đặt role cho tài khoản (chạy trong thư mục tools, cần file khóa dịch vụ như import.js):
 *   node set-role.js vitc admin --company=VITC --password=MatKhau1    admin công ty VITC Garment (chưa có thì tạo mới)
 *   node set-role.js lptex admin --company=LPTEX --password=MatKhau2  admin công ty LPTEX
 *   node set-role.js bep01 user                                       tài khoản chỉ quét suất thường
 *   node set-role.js bep02 chay                                       tài khoản chỉ quét suất chay
 * --password chỉ cần khi tài khoản chưa tồn tại (>= 6 ký tự). Admin bắt buộc có --company.
 * Sau khi đổi role, người đó phải đăng xuất rồi đăng nhập lại để có hiệu lực.
 *******************************************************/
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const [username, role] = args.filter(a => !a.startsWith('--'));
const pwArg = args.find(a => a.startsWith('--password='));
const coArg = args.find(a => a.startsWith('--company='));
const company = coArg ? coArg.slice(10).trim().toUpperCase() : '';
const ROLES = { admin: 'ADMIN', user: '', chay: 'CHAY' };
if (!username || !(role in ROLES)) {
  console.log('Cách dùng: node set-role.js <tên đăng nhập> admin|user|chay [--password=...]');
  process.exit(1);
}
if (role === 'admin' && !['VITC', 'LPTEX'].includes(company)) {
  console.error('Admin cần --company=VITC hoặc --company=LPTEX.');
  process.exit(1);
}

let keyFile = path.resolve(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(keyFile)) {
  const found = fs.readdirSync(__dirname).filter(f => /firebase-adminsdk.*\.json$/i.test(f));
  if (found.length !== 1) { console.error('Không tìm thấy file khóa dịch vụ trong thư mục tools.'); process.exit(1); }
  keyFile = path.resolve(__dirname, found[0]);
}
initializeApp({ credential: cert(JSON.parse(fs.readFileSync(keyFile, 'utf8'))) });
const auth = getAuth();
const toUser = u => String(u).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');   // giống import.js và index.html

(async () => {
  const email = `${toUser(username)}@nhaan.local`;
  let rec;
  try { rec = await auth.getUserByEmail(email); }
  catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    if (!pwArg || pwArg.slice(11).length < 6) { console.error(`Chưa có tài khoản ${email}. Thêm --password=... (>= 6 ký tự) để tạo mới.`); process.exit(1); }
    rec = await auth.createUser({ email, password: pwArg.slice(11), displayName: toUser(username) });
    console.log('Đã tạo tài khoản', email);
  }
  await auth.setCustomUserClaims(rec.uid, role === 'admin' ? { role: 'ADMIN', company } : { role: ROLES[role] });
  console.log(`Tài khoản ${toUser(username)} -> role: ${role}${role === 'admin' ? ', công ty: ' + company : ''}`);
})().catch(e => { console.error(e); process.exit(1); });
