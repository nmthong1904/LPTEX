/*******************************************************
 * Tạo DỮ LIỆU MẪU ngẫu nhiên (lượt nhận suất ăn + lượt bị từ chối) để thử báo cáo và tốc độ khi dữ liệu lớn.
 * Chạy trong thư mục tools (cần serviceAccountKey.json như import.js):
 *   node seed-sample.js firebase_export.json --dry                xem thống kê, KHÔNG ghi gì
 *   node seed-sample.js firebase_export.json                      ghi vào Firestore (20/09/2026 - 20/10/2026)
 *   node seed-sample.js firebase_export.json --delete             xóa toàn bộ dữ liệu mẫu đã ghi
 * Tùy chọn:  --from=2026-09-20 --to=2026-10-20 --attend=0.88 --veg=0.04 --refuse=0.015 --seed=2026
 * Mọi tài liệu mẫu có ID bắt đầu bằng "SAMPLE_" nên xóa sạch được, không đụng dữ liệu thật.
 * Chạy lại cùng tham số sẽ ghi đè đúng các tài liệu cũ (không bị nhân đôi).
 * Không ghi lastMeal để không ảnh hưởng việc quét thật.
 *******************************************************/
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--')) || 'firebase_export.json';
const opt = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const DRY = args.includes('--dry'), DEL = args.includes('--delete');
const FROM = opt('from', '2026-09-20'), TO = opt('to', '2026-10-20');
const ATTEND = +opt('attend', 0.88), VEG = +opt('veg', 0.04), REFUSE = +opt('refuse', 0.015), SEED = +opt('seed', 2026);
const PREFIX = 'SAMPLE_';

// bộ sinh số ngẫu nhiên cố định theo seed (cùng seed -> cùng dữ liệu)
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pickW = list => { let r = rnd() * list.reduce((a, b) => a + b[1], 0); for (const [v, w] of list) { if ((r -= w) < 0) return v; } return list[0][0]; };

const safe = x => String(x).trim().replace(/\//g, '_');
const plain = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().trim();

function initDb() {
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore, Timestamp, FieldPath } = require('firebase-admin/firestore');
  let keyFile = path.resolve(__dirname, 'serviceAccountKey.json');
  if (!fs.existsSync(keyFile)) {
    const found = fs.readdirSync(__dirname).filter(f => /firebase-adminsdk.*\.json$/i.test(f));
    if (found.length !== 1) { console.error('Không tìm thấy file khóa dịch vụ trong thư mục tools.'); process.exit(1); }
    keyFile = path.resolve(__dirname, found[0]);
  }
  const sa = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  console.log('Project:', sa.project_id);
  initializeApp({ credential: cert(sa) });
  return { db: getFirestore(), Timestamp, FieldPath };
}
const bulkWriter = db => {
  const bw = db.bulkWriter();
  bw.onWriteError(err => { if (err.failedAttempts < 5) return true; console.error('Lỗi ghi', err.documentRef.path, err.message); return false; });
  return bw;
};

(async () => {
  // ---------- xóa dữ liệu mẫu ----------
  if (DEL) {
    const { db, FieldPath } = initDb();
    const bw = bulkWriter(db);
    let n = 0;
    for (const col of ['meals', 'refused']) {
      const snap = await db.collection(col).where(FieldPath.documentId(), '>=', PREFIX).where(FieldPath.documentId(), '<', PREFIX + '').select().get();
      snap.docs.forEach(d => { bw.delete(d.ref); n++; });
    }
    await bw.close();
    console.log(`Đã xóa ${n} tài liệu mẫu. XONG.`);
    return;
  }

  // ---------- dựng dữ liệu ----------
  const d = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const emps = d.employees.filter(e => !plain(e.trangThai) && !e.hetHan);          // bỏ người bị khóa / hết hạn
  const scanners = (d.users || []).map(u => `${u.hoTen} (${u.username})`);
  const normalScanners = scanners.length ? scanners.map((n, i) => [n, [50, 30, 15, 5][i] || 5]) : [['user1', 1]];
  const vegScanner = 'Quét suất chay (chay01)';
  const vegSet = new Set(emps.filter(() => rnd() < VEG).map(e => safe(e.key)));      // nhân viên ăn chay cố định

  const days = [];
  for (let t = Date.parse(FROM + 'T00:00:00Z'); t <= Date.parse(TO + 'T00:00:00Z'); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));

  const meals = [], refused = [];
  const lunchMs = () => ((rnd() + rnd()) / 2 * 135 * 60 + 11 * 3600 + 5) * 1000;   // dồn nhiều về giữa giờ 11:00-13:15
  for (const date of days) {
    const wd = new Date(date + 'T00:00:00Z').getUTCDay();
    if (wd === 0) continue;                                                         // chủ nhật nghỉ
    const rate = wd === 6 ? ATTEND * 0.6 : ATTEND;                                  // thứ bảy ít người hơn
    const base = Date.parse(date + 'T00:00:00+07:00');
    for (const e of emps) {
      if (rnd() > rate) continue;
      const key = safe(e.key), veg = vegSet.has(key);
      const time = Math.round(base + lunchMs());
      meals.push({
        id: `${PREFIX}${time}_${key}`, time, date, empKey: key, msnv: e.msnv, hoTen: e.hoTen, donVi: e.donVi,
        scanner: veg ? vegScanner : pickW(normalScanners), loai: veg ? 'chay' : 'thuong', x: e.x || {}
      });
      if (rnd() < REFUSE) {                                                         // quét lỗi: thẻ thu hồi / không tìm thấy / hết hạn
        const kind = pickW([['rev', 5], ['nf', 3], ['exp', 2]]);
        const lyDo = kind === 'rev' ? `Thẻ này đã bị thu hồi (mất hoặc đã thay thẻ mới). Không cấp suất ăn. [${e.the || 'XXXXXXXXXX'}]`
          : kind === 'nf' ? 'Không tìm thấy thẻ có mã: ' + Array.from({ length: 10 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(rnd() * 31)]).join('')
          : 'Hợp đồng đã hết hạn. Không cấp suất ăn.';
        refused.push({ time: time + Math.round(rnd() * 600000 - 300000), msnv: kind === 'nf' ? '' : e.msnv, hoTen: kind === 'nf' ? '' : e.hoTen, donVi: kind === 'nf' ? '' : e.donVi, lyDo, scanner: pickW(normalScanners) });
      }
    }
  }
  refused.forEach((r, i) => { r.id = `${PREFIX}${r.time}_${i}`; });

  const perDay = {}; meals.forEach(m => { perDay[m.date] = (perDay[m.date] || 0) + 1; });
  console.log(`Nhân viên dùng để tạo: ${emps.length} (ăn chay cố định: ${vegSet.size})`);
  console.log(`Khoảng ngày: ${FROM} -> ${TO} (${days.length} ngày)`);
  console.log(`Lượt nhận suất: ${meals.length} | lượt bị từ chối: ${refused.length} | tổng tài liệu sẽ ghi: ${meals.length + refused.length}`);
  console.log('Ví dụ số suất mỗi ngày:', days.slice(0, 7).map(x => `${x.slice(5)}:${perDay[x] || 0}`).join('  '));
  if (meals.length + refused.length > 18000) console.log('CHÚ Ý: gói miễn phí Firestore chỉ cho 20.000 lượt ghi mỗi ngày. Hãy giảm --attend hoặc chia nhỏ khoảng ngày (--from/--to).');
  if (DRY) { console.log('(--dry) Không ghi gì vào Firestore.'); return; }

  // ---------- ghi vào Firestore ----------
  const { db, Timestamp } = initDb();
  const bw = bulkWriter(db);
  meals.forEach(m => bw.set(db.doc(`meals/${m.id}`), {
    time: Timestamp.fromMillis(m.time), date: m.date, empKey: m.empKey, msnv: m.msnv, hoTen: m.hoTen, donVi: m.donVi,
    trangThai: 'ĐÃ NHẬN', scanner: m.scanner, loai: m.loai, x: m.x
  }));
  refused.forEach(r => bw.set(db.doc(`refused/${r.id}`), {
    time: Timestamp.fromMillis(r.time), msnv: r.msnv, hoTen: r.hoTen, donVi: r.donVi, lyDo: r.lyDo, scanner: r.scanner
  }));
  await bw.close();
  console.log('Đã ghi xong. Muốn xóa dữ liệu mẫu: node seed-sample.js --delete . XONG.');
})().catch(e => { console.error(e); process.exit(1); });
