/**
 * แจ้งเตือนทาง LINE เรื่องคำขอเข้า Office (ผ่านบอท S Leasing Tools)
 *
 *   1) มีคำขอใหม่ (ลงทะเบียน / ขอย้าย LINE)  → แจ้ง Hub RM ของ Hub นั้น + AM ของคนนั้น
 *   2) คำขอได้ผล                               → แจ้งผู้ขอ: อนุมัติแล้ว / ยังไม่ได้รับอนุมัติ
 *   ไม่แจ้งเจ้าของบอท (SECRETARY_OWNER_ID) และไม่แจ้งตัวผู้ขอเองในข้อ 1
 *
 * ทำงานจากตัวจับเวลาทุก 5 นาที อ่านชีต Staff_Master (Staff / Roles / LineMove) ไม่ต้อง Deploy เว็บแอปใหม่
 * ใช้ staffSheets_ / sheetRows_ / issueToken_ จาก IssueIntake.gs
 *
 * ใช้งาน (กด Run ครั้งละหนึ่งครั้ง ดูผลที่ Execution log)
 *   1) testOfficeNotify      → ส่งข้อความตัวอย่างหาเจ้าของบอทคนเดียว (ไม่ส่งหาคนอื่น ไม่บันทึกสถานะ)
 *   2) installOfficeNotifyTrigger → เริ่มทำงานทุก 5 นาที (รอบแรกบันทึกคำขอที่ค้างอยู่ตอนนี้ไว้เฉย ๆ ไม่ส่ง)
 *   หยุด: removeOfficeNotifyTrigger · ล้างความจำ: resetOfficeNotifyState
 */
const NOTIFY_CFG = {
  officeUrl: 'https://liff.line.me/2012282702-qtqjFxgj?go=home',
  stateProp: 'OFFICE_NOTIFY_STATE',
  ownerProp: 'SECRETARY_OWNER_ID',
  approverRoles: { HRM: 'HUB', AM: 'AM' },     // บทบาท → ขอบเขตที่ต้องตรงกับคนขอ
  maxAgeDays: 14                               // ลืมคำขอที่ค้างเกินนี้ ไม่ตามแจ้งอีก
};
// สถานะที่จำไว้: { sent: { key: เวลา } , pend: { key: {uid, emp, kind, line} } , seeded: true }

function officeNotifyRun_(opts) {
  const dry = opts && opts.dry;
  const props = PropertiesService.getScriptProperties();
  const owner = props.getProperty(NOTIFY_CFG.ownerProp) || '';
  const state = JSON.parse(props.getProperty(NOTIFY_CFG.stateProp) || '{"sent":{},"pend":{}}');
  state.sent = state.sent || {}; state.pend = state.pend || {};
  const firstRun = !state.seeded;

  const st = staffSheets_();
  const staff = sheetRows_(st.staff), roles = sheetRows_(st.roles).filter(r => String(r['Active']).toUpperCase() === 'Y');
  const byEmp = {}; staff.forEach(p => { byEmp[p['Emp Code']] = p; });
  const moves = sheetRowsRaw_(st.ss.getSheetByName('LineMove'));   // [เวลา, รหัส, LINE ใหม่, ชื่อ, สถานะ, ผู้ตัดสิน, เวลา]
  const out = { toApprovers: 0, toRequesters: 0, seeded: 0 };
  const now = Date.now(), maxAge = NOTIFY_CFG.maxAgeDays * 86400000;

  // ---------- 1) คำขอใหม่ ----------
  const requests = [];
  staff.forEach(p => {
    if (String(p['Access Status']).toUpperCase() === 'PENDING' && p['LINE User ID'] && String(p['Approved By']).indexOf('LINE:') === 0)
      requests.push({ key: 'R:' + p['Emp Code'] + ':' + p['LINE User ID'], kind: 'reg', emp: p['Emp Code'], uid: p['LINE User ID'], lineName: String(p['Approved By']).replace('LINE: ', '') });
  });
  moves.forEach(m => {
    if (m[4] === 'PENDING') requests.push({ key: 'M:' + m[1] + ':' + m[2], kind: 'move', emp: String(m[1]), uid: String(m[2]), lineName: String(m[3]) });
  });

  requests.forEach(q => {
    if (state.sent[q.key]) return;
    state.sent[q.key] = now;
    state.pend[q.key] = { uid: q.uid, emp: q.emp, kind: q.kind, at: now };
    if (firstRun) { out.seeded++; return; }                       // คำขอที่ค้างอยู่ก่อนเริ่มระบบ: ไม่ส่ง
    const person = byEmp[q.emp]; if (!person) return;
    const to = approversOf_(person, roles, byEmp, owner).filter(u => u !== q.uid);
    if (!to.length) return;
    const nm = (person['ชื่อ-นามสกุล'] || q.emp) + (person['ชื่อเล่น'] ? ' (' + person['ชื่อเล่น'] + ')' : '');
    const text = '🔔 มีคำขอรออนุมัติ' + (q.kind === 'move' ? ' (ขอย้าย LINE)' : '') + '\n' + nm + ' · ' + (person['Position (System)'] || '') +
      '\n' + (person['AM'] || '') + (person['HUB'] ? ' · Hub ' + person['HUB'] : '') + '\nLINE: ' + q.lineName +
      '\n\nเปิดหน้าอนุมัติ: ' + NOTIFY_CFG.officeUrl;
    if (!dry) multicast_(to, text);
    out.toApprovers += to.length;
  });

  // ---------- 2) แจ้งผู้ขอเมื่อได้ผล ----------
  Object.keys(state.pend).forEach(key => {
    const p = state.pend[key];
    if (now - p.at > maxAge) { delete state.pend[key]; return; }
    let result = '';
    if (p.kind === 'reg') {
      const me = byEmp[p.emp];
      if (me && me['LINE User ID'] === p.uid && String(me['Access Status']).toUpperCase() === 'APPROVED') result = 'OK';
      else if (!me || me['LINE User ID'] !== p.uid) result = 'NO';          // ถูกปฏิเสธ (ล้าง LINE ออก) หรือถูกเปลี่ยนไปแล้ว
    } else {
      const mv = moves.filter(m => String(m[1]) === p.emp && String(m[2]) === p.uid).pop();
      if (mv && mv[4] === 'APPROVED') result = 'OK'; else if (mv && mv[4] === 'REJECTED') result = 'NO';
    }
    if (!result) return;
    delete state.pend[key];
    if (firstRun || p.uid === owner) return;
    const text = result === 'OK'
      ? '✅ อนุมัติแล้ว เปิด Office ได้เลย\n' + NOTIFY_CFG.officeUrl
      : 'คำขอของคุณยังไม่ได้รับอนุมัติ\nกรุณาติดต่อหัวหน้าเพื่อตรวจสอบรหัสพนักงาน แล้วลองลงทะเบียนอีกครั้ง';
    if (!dry) multicast_([p.uid], text);
    out.toRequesters++;
  });

  // ตัดประวัติเก่า
  Object.keys(state.sent).forEach(k => { if (now - state.sent[k] > maxAge * 4) delete state.sent[k]; });
  state.seeded = true;
  if (!dry) props.setProperty(NOTIFY_CFG.stateProp, JSON.stringify(state));
  return out;
}

/** รายชื่อ LINE ID ของผู้อนุมัติของคนนี้: Hub RM ใน Hub เดียวกัน + AM ใน AM เดียวกัน (ไม่เอาตัวเอง ไม่เอาเจ้าของบอท) */
function approversOf_(person, roles, byEmp, owner) {
  const ids = {};
  roles.forEach(r => {
    const scope = NOTIFY_CFG.approverRoles[String(r['Role']).toUpperCase()];
    if (!scope || r['Emp Code'] === person['Emp Code']) return;
    const match = scope === 'HUB' ? (r['HUB'] && r['HUB'] === person['HUB']) : (r['AM'] && r['AM'] === person['AM']);
    if (!match) return;
    const a = byEmp[r['Emp Code']];
    if (a && a['LINE User ID'] && String(a['Access Status']).toUpperCase() === 'APPROVED' && a['LINE User ID'] !== owner) ids[a['LINE User ID']] = 1;
  });
  return Object.keys(ids);
}

function sheetRowsRaw_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 7).getDisplayValues();
}

function multicast_(userIds, text) {
  for (let i = 0; i < userIds.length; i += 500) {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/multicast', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + issueToken_() },
      payload: JSON.stringify({ to: userIds.slice(i, i + 500), messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) console.error('LINE multicast ตอบ ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
}

/** ตัวจับเวลาเรียกฟังก์ชันนี้ */
function officeNotifyTick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const o = officeNotifyRun_({});
    if (o.toApprovers || o.toRequesters || o.seeded) console.log('แจ้งเตือน Office: หัวหน้า ' + o.toApprovers + ' · ผู้ขอ ' + o.toRequesters + (o.seeded ? ' · จำคำขอเดิม ' + o.seeded : ''));
  } catch (e) { console.error('officeNotifyTick: ' + e); } finally { lock.releaseLock(); }
}

function installOfficeNotifyTrigger() {
  removeOfficeNotifyTrigger();
  ScriptApp.newTrigger('officeNotifyTick').timeBased().everyMinutes(5).create();
  officeNotifyTick();      // รอบแรก: จำคำขอที่ค้างอยู่ตอนนี้ไว้ (ไม่ส่ง)
  console.log('ตั้งแจ้งเตือน Office ทุก 5 นาทีแล้ว');
}
function removeOfficeNotifyTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'officeNotifyTick').forEach(t => ScriptApp.deleteTrigger(t));
}
function resetOfficeNotifyState() { PropertiesService.getScriptProperties().deleteProperty(NOTIFY_CFG.stateProp); console.log('ล้างความจำแล้ว'); }

/** ทดลอง: ส่งข้อความตัวอย่างหาเจ้าของบอทคนเดียว */
function testOfficeNotify() {
  const owner = PropertiesService.getScriptProperties().getProperty(NOTIFY_CFG.ownerProp);
  if (!owner) { console.log('ไม่พบ SECRETARY_OWNER_ID'); return; }
  multicast_([owner], '🔔 (ทดลอง) มีคำขอรออนุมัติ\nสมชาย ตัวอย่าง (ชาย) · Team Manager\nAM2 · Hub H21\nLINE: Chai\n\nเปิดหน้าอนุมัติ: ' + NOTIFY_CFG.officeUrl);
  multicast_([owner], '✅ (ทดลอง) อนุมัติแล้ว เปิด Office ได้เลย\n' + NOTIFY_CFG.officeUrl);
  console.log('ส่งข้อความทดลอง 2 ข้อความหาเจ้าของบอทแล้ว');
}
