/**
 * ผูกเมนูล่าง (Rich menu) ตามตำแหน่ง จากรายชื่อที่อนุมัติแล้วในระบบออฟฟิศ (ชีต Staff_Master)
 *
 *   ทุกคน (CK / BK / AG / คนที่ยังไม่ลงทะเบียน) → เมนูหลัก staff-sales-v1 (ตั้งเป็น default ไว้แล้ว)
 *   TM                                          → staff-tm-v1
 *   Hub RM / AM / ผอ.                           → staff-hubrm-v1   (มีปุ่มบันทึกปัญหา)
 *   เจ้าของบอท (SECRETARY_OWNER_ID)             → ไม่แตะ ใช้เมนูน้องป๋อนเหมือนเดิม
 *
 * ใช้งาน
 *   1) เลือกฟังก์ชัน syncStaffMenus แล้วกด Run หนึ่งครั้ง (กดอนุญาตถ้า Google ถาม) ดูผลที่ Execution log
 *   2) เลือก installStaffMenuSyncTrigger แล้วกด Run หนึ่งครั้ง → ระบบจะซิงก์เองทุกชั่วโมง
 *   ยกเลิกอัตโนมัติ: removeStaffMenuSyncTrigger · ถอดเมนูที่ผูกไว้ทั้งหมด: unlinkAllStaffMenus
 *
 * ไฟล์นี้ใช้ staffSheets_ / sheetRows_ / issueToken_ จาก IssueIntake.gs
 * ทำงานจากตัวจับเวลา จึงไม่ต้อง Deploy เว็บแอปใหม่
 */
const STAFF_MENU_CFG = {
  menus: {
    tm: 'richmenu-678d8a2e0b1ea5799c00aed358bc3626',     // staff-tm-v1
    hubrm: 'richmenu-24228a20ff9a11bd95d90e640923bf32'   // staff-hubrm-v1
  },
  roleToMenu: { TM: 'tm', HRM: 'hubrm', AM: 'hubrm', DIR: 'hubrm' },
  priority: ['hubrm', 'tm'],          // คนที่มีหลายบทบาท ใช้เมนูที่อยู่ก่อนในรายการนี้
  stateProp: 'STAFF_MENU_STATE',      // จำว่าผูกใครกับเมนูไหนไปแล้ว (LINE ID → tm/hubrm)
  ownerProp: 'SECRETARY_OWNER_ID'
};

/** ซิงก์เมนูตามรายชื่อที่อนุมัติแล้ว ผูกเฉพาะคนที่เปลี่ยน · ถอดคนที่ไม่ได้อยู่ในตำแหน่งนั้นแล้ว */
function syncStaffMenus() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { console.log('มีการซิงก์อื่นกำลังทำงาน ข้ามรอบนี้'); return; }
  try {
    const props = PropertiesService.getScriptProperties();
    const owner = props.getProperty(STAFF_MENU_CFG.ownerProp) || '';
    const state = JSON.parse(props.getProperty(STAFF_MENU_CFG.stateProp) || '{}');

    // 1) คนที่อนุมัติแล้ว + บทบาทที่ยังใช้งาน
    const st = staffSheets_();
    const staff = sheetRows_(st.staff);
    const roles = sheetRows_(st.roles).filter(r => String(r['Active']).toUpperCase() === 'Y');
    const rolesByEmp = {};
    roles.forEach(r => { (rolesByEmp[r['Emp Code']] = rolesByEmp[r['Emp Code']] || []).push(String(r['Role']).toUpperCase()); });

    const want = {};                                   // LINE ID → tm / hubrm
    staff.forEach(p => {
      const uid = p['LINE User ID'];
      if (!uid || uid === owner || String(p['Access Status']).toUpperCase() !== 'APPROVED') return;
      const keys = (rolesByEmp[p['Emp Code']] || []).map(r => STAFF_MENU_CFG.roleToMenu[r]).filter(Boolean);
      const menu = STAFF_MENU_CFG.priority.find(k => keys.indexOf(k) >= 0);
      if (menu) want[uid] = menu;
    });

    // 2) เทียบกับที่ผูกไว้แล้ว
    const toLink = { tm: [], hubrm: [] }, toUnlink = [];
    Object.keys(want).forEach(uid => { if (state[uid] !== want[uid]) toLink[want[uid]].push(uid); });
    Object.keys(state).forEach(uid => { if (!want[uid] && uid !== owner) toUnlink.push(uid); });

    // 3) สั่ง LINE (ทีละไม่เกิน 500 คน)
    const done = Object.assign({}, state);
    Object.keys(toLink).forEach(k => chunk_(toLink[k], 500).forEach(ids => {
      lineMenuCall_('/v2/bot/richmenu/bulk/link', { richMenuId: STAFF_MENU_CFG.menus[k], userIds: ids });
      ids.forEach(uid => { done[uid] = k; });
    }));
    chunk_(toUnlink, 500).forEach(ids => {
      lineMenuCall_('/v2/bot/richmenu/bulk/unlink', { userIds: ids });
      ids.forEach(uid => { delete done[uid]; });
    });

    props.setProperty(STAFF_MENU_CFG.stateProp, JSON.stringify(done));
    console.log('ซิงก์เมนูเสร็จ · ผูก TM ' + toLink.tm.length + ' · ผูก Hub RM ขึ้นไป ' + toLink.hubrm.length +
      ' · ถอด ' + toUnlink.length + ' · รวมที่ผูกอยู่ ' + Object.keys(done).length + ' คน');
  } finally {
    lock.releaseLock();
  }
}

/** ตั้งให้ซิงก์เองทุกชั่วโมง (กด Run ครั้งเดียว) */
function installStaffMenuSyncTrigger() {
  removeStaffMenuSyncTrigger();
  ScriptApp.newTrigger('syncStaffMenus').timeBased().everyHours(1).create();
  console.log('ตั้งซิงก์เมนูอัตโนมัติทุกชั่วโมงแล้ว');
}

/** ยกเลิกการซิงก์อัตโนมัติ (เมนูที่ผูกไว้ยังอยู่) */
function removeStaffMenuSyncTrigger() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncStaffMenus')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** ถอดเมนูที่ฟังก์ชันนี้ผูกไว้ทั้งหมด ทุกคนกลับไปเห็นเมนูหลัก (เมนูน้องป๋อนไม่แตะ) */
function unlinkAllStaffMenus() {
  const props = PropertiesService.getScriptProperties();
  const state = JSON.parse(props.getProperty(STAFF_MENU_CFG.stateProp) || '{}');
  chunk_(Object.keys(state), 500).forEach(ids => lineMenuCall_('/v2/bot/richmenu/bulk/unlink', { userIds: ids }));
  props.deleteProperty(STAFF_MENU_CFG.stateProp);
  console.log('ถอดเมนูแล้ว ' + Object.keys(state).length + ' คน');
}

function lineMenuCall_(path, body) {
  const res = UrlFetchApp.fetch('https://api.line.me' + path, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + issueToken_() }, muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200 && code !== 202) throw new Error('LINE ' + path + ' ตอบ ' + code + ': ' + res.getContentText().slice(0, 200));
}

function chunk_(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
