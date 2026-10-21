/*******************************************************
 * Cấp lại thẻ (mất thẻ / hỏng thẻ): thu hồi mã thẻ cũ, tạo mã thẻ mới, xuất ảnh QR.
 * Cách dùng (trong thư mục tools):
 *   npm install qrcode                         (chỉ cần chạy 1 lần)
 *   node reissue.js 1669                       xem trước, CHƯA thay đổi gì
 *   node reissue.js 1669 --yes                 thực hiện thật
 *   node reissue.js 1669 --yes --reason="Mất thẻ ngày 21/10"
 *   node reissue.js LPTEX:8 --yes              nhân viên LPTEX trùng MSNV với VITC thì dùng khóa LPTEX:8
 * Kết quả nằm trong thư mục tools/qr-moi/ :
 *   the_<mã>_<msnv>.html  trang thẻ khổ 85,6 x 54 mm (thẻ nhựa chuẩn): mở bằng Chrome, nhấn Ctrl+P để in
 *   the_<mã>_<msnv>.png   ảnh QR riêng, để chèn vào mẫu thẻ có sẵn của công ty (nội dung QR = mã thẻ 10 ký tự)
 * Cần file khóa serviceAccountKey.json (hoặc *-firebase-adminsdk-*.json) cạnh file này, giống import.js.
 *******************************************************/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const safe = s => String(s).trim().replace(/\//g, '_');
const plain = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().trim();

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // bỏ 0 O 1 I L cho dễ đọc khi gõ tay
const newCode = () => Array.from({ length: 10 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

async function findEmployee(db, arg) {
  const direct = await db.doc(`employees/${safe(arg)}`).get();
  if (direct.exists) return { key: direct.id, data: direct.data() };
  const q = await db.collection('employees').where('msnv', '==', String(arg).trim()).get();
  if (q.docs.length === 1) return { key: q.docs[0].id, data: q.docs[0].data() };
  if (q.docs.length > 1) throw new Error('Có nhiều nhân viên trùng MSNV ' + arg + ': ' + q.docs.map(d => d.id).join(', ') + '. Hãy chạy lại với khóa đầy đủ (ví dụ LPTEX:' + arg + ').');
  throw new Error('Không tìm thấy nhân viên: ' + arg);
}

async function reissue(db, Timestamp, opts) {
  const emp = await findEmployee(db, opts.arg);
  const e = emp.data;
  const oldSnap = await db.collection('cards').where('key', '==', emp.key).get();
  const oldCodes = oldSnap.docs.map(d => d.id);

  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    const c = newCode();
    if (!(await db.doc(`cards/${c}`).get()).exists) code = c;
  }
  if (!code) throw new Error('Không tạo được mã thẻ mới, hãy chạy lại.');

  const st = plain(e.trangThai);
  const clearStatus = /MAT THE/.test(st);                       // trạng thái "MẤT THẺ" sẽ chặn cả thẻ mới nên phải xóa
  const stillBlocked = !!st && !clearStatus && /KHOA|LOCK|NGHI|THOI VIEC/.test(st);
  const plan = {
    key: emp.key, msnv: e.msnv, hoTen: e.hoTen, donVi: e.donVi, sheet: e.sheet, congTy: (e.x && e.x.CONG_TY) || '',
    oldCodes, newCode: code, clearStatus, trangThai: e.trangThai || '', stillBlocked
  };
  if (!opts.yes) return { plan, done: false };

  const reason = opts.reason || 'Mất thẻ / đã cấp lại thẻ mới';
  const batch = db.batch();
  oldCodes.forEach(c => batch.set(db.doc(`cards/${c}`), {
    revoked: true, msnv: e.msnv || '', hoTen: e.hoTen || '', lyDo: reason, revokedAt: Timestamp.now()
  }));
  batch.set(db.doc(`cards/${code}`), { key: emp.key });
  if (clearStatus) batch.update(db.doc(`employees/${emp.key}`), { trangThai: '' });
  await batch.commit();
  return { plan, done: true };
}

async function makeQr(code, file) {
  let QRCode;
  try { QRCode = require('qrcode'); }
  catch (e) { throw new Error('Chưa cài thư viện qrcode. Chạy: npm install qrcode'); }
  await QRCode.toFile(file, code, { width: 700, margin: 3, errorCorrectionLevel: 'M' });
}

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Trang thẻ khổ CR80 (85,6 x 54 mm): mở bằng trình duyệt rồi in. Muốn đổi bố cục thì sửa phần CSS bên dưới.
async function makeCardHtml(p, file) {
  let QRCode;
  try { QRCode = require('qrcode'); }
  catch (e) { throw new Error('Chưa cài thư viện qrcode. Chạy: npm install qrcode'); }
  const img = await QRCode.toDataURL(p.newCode, { width: 600, margin: 1, errorCorrectionLevel: 'M' });
  const html = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Thẻ ${esc(p.hoTen)} - ${esc(p.msnv)}</title>
<style>
  @page { size: 85.6mm 54mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #e5e7eb; font-family: Arial, "Segoe UI", sans-serif; color: #111; }
  .tip { text-align: center; padding: 12px; font-size: 14px; }
  .card { width: 85.6mm; height: 54mm; margin: 6mm auto; background: #fff; display: flex; align-items: center; gap: 4mm; padding: 4mm; overflow: hidden; border-radius: 3mm; }
  .qr { width: 40mm; height: 40mm; flex: none; }
  .info { flex: 1; min-width: 0; }
  .co { font-size: 9pt; font-weight: 700; color: #1d4ed8; text-transform: uppercase; }
  .name { font-size: 12.5pt; font-weight: 700; line-height: 1.15; margin: 2mm 0; overflow-wrap: anywhere; }
  .meta { font-size: 9pt; line-height: 1.35; }
  .code { font-family: "Courier New", monospace; font-size: 9pt; margin-top: 2.5mm; letter-spacing: .5px; }
  @media print { body { background: #fff; } .tip { display: none; } .card { margin: 0; border-radius: 0; } }
</style></head><body>
<div class="tip">Nhấn <b>Ctrl + P</b> để in. Chọn khổ giấy 85,6 x 54 mm (thẻ nhựa), hoặc in ra A4 rồi cắt. Tắt "Header and footer", Scale = 100%.</div>
<div class="card">
  <img class="qr" src="${img}" alt="QR ${esc(p.newCode)}">
  <div class="info">
    <div class="co">${esc(p.congTy || p.sheet || '')}</div>
    <div class="name">${esc(p.hoTen)}</div>
    <div class="meta">MSNV: ${esc(p.msnv)}<br>${esc(p.donVi || '')}</div>
    <div class="code">${esc(p.newCode)}</div>
  </div>
</div>
</body></html>`;
  fs.writeFileSync(file, html, 'utf8');
}

module.exports = { reissue, makeQr, makeCardHtml, findEmployee, newCode };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const arg = args.find(a => !a.startsWith('--'));
    const yes = args.includes('--yes');
    const rArg = args.find(a => a.startsWith('--reason='));
    if (!arg) { console.log('Cách dùng: node reissue.js <MSNV hoặc khóa> [--yes] [--reason="..."]'); process.exit(1); }

    let keyFile = path.resolve(__dirname, 'serviceAccountKey.json');
    if (!fs.existsSync(keyFile)) {
      const found = fs.readdirSync(__dirname).filter(f => /firebase-adminsdk.*\.json$/i.test(f));
      if (found.length !== 1) { console.error('Không tìm thấy file khóa dịch vụ trong thư mục tools.'); process.exit(1); }
      keyFile = path.resolve(__dirname, found[0]);
    }
    const sa = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getFirestore, Timestamp } = require('firebase-admin/firestore');
    initializeApp({ credential: cert(sa) });
    console.log('Project:', sa.project_id);

    const r = await reissue(getFirestore(), Timestamp, { arg, yes, reason: rArg ? rArg.slice(9) : '' });
    const p = r.plan;
    console.log(`Nhân viên : ${p.hoTen} (MSNV ${p.msnv}, khóa ${p.key}, ${p.sheet || '-'}, ${p.donVi || '-'})`);
    console.log(`Thẻ cũ    : ${p.oldCodes.length ? p.oldCodes.join(', ') : '(không có)'}  ->  sẽ bị THU HỒI`);
    console.log(`Thẻ mới   : ${p.newCode}`);
    if (p.clearStatus) console.log(`Trạng thái "${p.trangThai}" sẽ được xóa để thẻ mới dùng được.`);
    if (p.stillBlocked) console.log(`CHÚ Ý: nhân viên đang ở trạng thái "${p.trangThai}", thẻ mới vẫn sẽ bị từ chối cho đến khi bạn sửa trạng thái trong Firestore.`);
    if (!r.done) { console.log('\nĐây mới là xem trước. Thêm --yes để thực hiện.'); return; }

    const dir = path.resolve(__dirname, 'qr-moi');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `the_${p.newCode}_${String(p.msnv).replace(/[^A-Za-z0-9_-]/g, '')}`);
    await makeQr(p.newCode, base + '.png');
    await makeCardHtml(p, base + '.html');
    console.log('\nĐÃ CẤP THẺ MỚI.');
    console.log('Trang thẻ để in :', base + '.html');
    console.log('Ảnh QR riêng    :', base + '.png');
  })().catch(e => { console.error('LỖI:', e.message); process.exit(1); });
}
