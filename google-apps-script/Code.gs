/**
 * Trinh N Yoga Studio API
 * Google Apps Script Web App backed by Google Sheets.
 *
 * Required Script Properties:
 * - SPREADSHEET_ID: Google Sheet production ID (keep it in Script Properties)
 * - API_TOKEN: a long random secret (do not put it in the repository)
 */

const CONFIG = Object.freeze({
  timezone: 'Asia/Ho_Chi_Minh',
  sheets: {
    students: 'Students',
    payments: 'Payments',
    allocations: 'Allocations',
    settings: 'Settings',
  },
  fundNames: {
    spending: 'Chi tiêu',
    emergency: 'Khẩn cấp',
    savings: 'Tiết kiệm',
    investment: 'Đầu tư',
  },
  allocationFundNames: {
    debt: 'Trả nợ',
    spending: 'Chi tiêu',
    emergency: 'Khẩn cấp',
    savings: 'Tiết kiệm',
    investment: 'Đầu tư',
  },
});

function doGet(e) {
  return handleRequest_(e, 'GET');
}

function doPost(e) {
  return handleRequest_(e, 'POST');
}

function handleRequest_(e, method) {
  try {
    const body = method === 'POST' ? parseBody_(e) : {};
    const params = Object.assign({}, e && e.parameter ? e.parameter : {}, body);
    const action = String(params.action || (method === 'GET' ? 'health' : '')).trim();

    if (action === 'health') {
      return json_({ success: true, service: 'Trinh N Yoga Studio API', version: 2, time: isoNow_() });
    }

    assertAuthorized_(params.token);

    switch (action) {
      case 'bootstrap':
        return json_({ success: true, data: getBootstrapData_() });
      case 'createStudent':
        return json_({ success: true, data: createStudent_(params.student || params) });
      case 'updateStudent':
        return json_({ success: true, data: updateStudent_(params.studentId, params.student || params) });
      case 'deleteStudent':
        return json_({ success: true, data: deleteStudent_(params.studentId) });
      case 'createPayment':
        return json_({ success: true, data: createPayment_(params.payment || params) });
      case 'updateRates':
        return json_({ success: true, data: updateRates_(params.rates || {}) });
      case 'recordAttendance':
        return json_({ success: true, data: recordAttendance_(params.studentId) });
      default:
        throw new Error('Action không được hỗ trợ: ' + action);
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    return json_({ success: false, error: error.message || String(error) });
  }
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  const raw = e.postData.contents;
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (e.parameter && e.parameter.payload) return JSON.parse(e.parameter.payload);
    throw new Error('Dữ liệu gửi lên không phải JSON hợp lệ.');
  }
}

function getBootstrapData_() {
  const students = readObjects_(CONFIG.sheets.students).map(studentToClient_);
  const payments = readObjects_(CONFIG.sheets.payments);
  const allocationRows = readObjects_(CONFIG.sheets.allocations);
  const allocationMap = allocationRows.reduce(function (map, row) {
    const paymentId = String(row.Payment_ID || '');
    if (!map[paymentId]) map[paymentId] = {};
    map[paymentId][row.Fund_Key] = toNumber_(row.Amount);
    return map;
  }, {});

  const transactions = payments.map(function (row) {
    return {
      id: String(row.Payment_ID),
      date: dateOnly_(row.Paid_At),
      studentId: studentNumericId_(row.Student_ID),
      studentKey: String(row.Student_ID),
      student: String(row.Student_Name || ''),
      method: String(row.Method || ''),
      cycle: String(row.Cycle || ''),
      amount: toNumber_(row.Amount),
      note: String(row.Note || ''),
      allocations: Object.assign({ debt: 0, spending: 0, emergency: 0, savings: 0, investment: 0 }, allocationMap[row.Payment_ID] || {}),
    };
  }).sort(function (a, b) { return b.date.localeCompare(a.date); });

  return {
    students: students,
    transactions: transactions,
    rates: getRates_(),
    debt: getDebtSummary_(new Date()),
    spreadsheetId: getSpreadsheet_().getId(),
    generatedAt: isoNow_(),
  };
}

function createStudent_(input) {
  return withWriteLock_(function () {
    requireFields_(input, ['name', 'phone', 'plan', 'fee', 'start', 'end', 'due', 'totalSessions']);
    const sheet = getRequiredSheet_(CONFIG.sheets.students);
    const existing = readObjects_(CONFIG.sheets.students);
    const studentId = nextPrefixedId_(existing.map(function (row) { return row.Student_ID; }), 'HV-', 4);
    const start = parseDate_(input.start);
    const end = parseDate_(input.end);
    const due = parseDate_(input.due);
    if (end < start) throw new Error('Ngày kết thúc phải sau ngày bắt đầu.');
    const totalSessions = Math.max(1, Math.round(toNumber_(input.totalSessions)));
    const now = new Date();

    sheet.appendRow([
      studentId,
      cleanText_(input.name, 120),
      cleanText_(input.phone, 30),
      cleanText_(input.plan, 120),
      positiveMoney_(input.fee),
      start,
      end,
      due,
      'Đang học',
      cleanText_(input.note || '', 500),
      now,
      now,
      totalSessions,
      0,
      totalSessions,
      '',
      membershipToSheet_(input.membership || 'maintained'),
    ]);
    SpreadsheetApp.flush();
    return { studentId: studentId };
  });
}

function createPayment_(input) {
  return withWriteLock_(function () {
    requireFields_(input, ['studentId', 'amount', 'date', 'method']);
    const studentSheet = getRequiredSheet_(CONFIG.sheets.students);
    const paymentSheet = getRequiredSheet_(CONFIG.sheets.payments);
    const allocationSheet = getRequiredSheet_(CONFIG.sheets.allocations);
    const studentData = studentSheet.getDataRange().getValues();
    const studentKey = normalizeStudentKey_(input.studentId);
    let studentRowIndex = -1;
    let studentRow;
    for (let i = 1; i < studentData.length; i += 1) {
      if (String(studentData[i][0]) === studentKey) {
        studentRowIndex = i + 1;
        studentRow = studentData[i];
        break;
      }
    }
    if (!studentRow) throw new Error('Không tìm thấy học viên ' + studentKey + '.');

    const amount = positiveMoney_(input.amount);
    const paidAt = parseDate_(input.date);
    const rates = getRates_();
    validateRates_(rates);
    const existingPayments = readObjects_(CONFIG.sheets.payments);
    const paymentId = nextPaymentId_(existingPayments, paidAt);
    const now = new Date();

    paymentSheet.appendRow([
      paymentId,
      studentKey,
      String(studentRow[1]),
      paidAt,
      cleanText_(input.method, 40),
      cleanText_(input.cycle || 'Thanh toán kỳ hiện tại', 80),
      amount,
      cleanText_(input.note || '', 500),
      now,
    ]);

    const debtSummary = getDebtSummary_(paidAt);
    const allocationValues = calculateAllocations_(amount, rates, debtSummary.remaining);
    const allocationStart = allocationSheet.getLastRow();
    const rows = Object.keys(CONFIG.allocationFundNames).map(function (key, index) {
      return [
        'PB-' + String(allocationStart + index).padStart(4, '0'),
        paymentId,
        key,
        CONFIG.allocationFundNames[key],
        amount ? allocationValues[key] / amount : 0,
        allocationValues[key],
        now,
      ];
    });
    allocationSheet.getRange(allocationSheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    studentSheet.getRange(studentRowIndex, 9).setValue('Đang học');
    studentSheet.getRange(studentRowIndex, 12).setValue(now);
    SpreadsheetApp.flush();

    return { paymentId: paymentId, allocations: allocationValues };
  });
}

function updateStudent_(studentId, input) {
  return withWriteLock_(function () {
    requireFields_(input, ['name', 'phone', 'plan', 'fee', 'start', 'end', 'due', 'totalSessions']);
    const sheet = getRequiredSheet_(CONFIG.sheets.students);
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(String);
    const index = headerIndex_(headers);
    const studentKey = normalizeStudentKey_(studentId);
    const rowOffset = values.findIndex(function (row, rowIndex) { return rowIndex > 0 && String(row[index.Student_ID]) === studentKey; });
    if (rowOffset === -1) throw new Error('Không tìm thấy học viên ' + studentKey + '.');
    const row = values[rowOffset];
    const start = parseDate_(input.start);
    const end = parseDate_(input.end);
    if (end < start) throw new Error('Ngày kết thúc phải sau ngày bắt đầu.');
    const oldTotal = Math.max(0, toNumber_(row[index.Total_Sessions]));
    const oldUsed = Math.max(0, toNumber_(row[index.Sessions_Used]));
    const total = Math.max(1, Math.round(toNumber_(input.totalSessions)));
    const used = input.sessionsUsed === undefined ? Math.min(total, oldUsed) : Math.round(toNumber_(input.sessionsUsed));
    if (used < 0 || used > total) throw new Error('Số buổi đã tập phải từ 0 đến tổng số buổi.');
    row[index.Full_Name] = cleanText_(input.name, 120);
    row[index.Phone] = cleanText_(input.phone, 30);
    row[index.Plan_Name] = cleanText_(input.plan, 120);
    row[index.Fee] = positiveMoney_(input.fee);
    row[index.Start_Date] = start;
    row[index.End_Date] = end;
    row[index.Due_Date] = parseDate_(input.due);
    row[index.Status] = clientStatusToSheet_(input.status || statusToClient_(row[index.Status]));
    row[index.Membership_State] = membershipToSheet_(input.membership || membershipToClient_(row[index.Membership_State]));
    row[index.Notes] = cleanText_(input.note || '', 500);
    row[index.Updated_At] = new Date();
    row[index.Total_Sessions] = total;
    row[index.Sessions_Used] = used;
    row[index.Sessions_Remaining] = total - used;
    if (total !== oldTotal || used !== oldUsed || total - used !== 2) row[index.Low_Session_Alert_At] = '';
    sheet.getRange(rowOffset + 1, 1, 1, headers.length).setValues([row]);
    SpreadsheetApp.flush();
    return { studentId: studentKey };
  });
}

function deleteStudent_(studentId) {
  return withWriteLock_(function () {
    const studentKey = normalizeStudentKey_(studentId);
    const hasPayments = readObjects_(CONFIG.sheets.payments).some(function (row) { return String(row.Student_ID) === studentKey; });
    if (hasPayments) throw new Error('Học viên đã có phiếu thu nên không thể xóa. Hãy chuyển tình trạng tập sang Ngừng tập để giữ lịch sử tài chính.');
    const sheet = getRequiredSheet_(CONFIG.sheets.students);
    const values = sheet.getDataRange().getValues();
    const rowOffset = values.findIndex(function (row, rowIndex) { return rowIndex > 0 && String(row[0]) === studentKey; });
    if (rowOffset === -1) throw new Error('Không tìm thấy học viên ' + studentKey + '.');
    sheet.deleteRow(rowOffset + 1);
    SpreadsheetApp.flush();
    return { studentId: studentKey, deleted: true };
  });
}

function updateRates_(rates) {
  return withWriteLock_(function () {
    const normalized = {
      spending: toNumber_(rates.spending),
      emergency: toNumber_(rates.emergency),
      savings: toNumber_(rates.savings),
      investment: toNumber_(rates.investment),
    };
    validateRates_(normalized);
    const sheet = getRequiredSheet_(CONFIG.sheets.settings);
    const values = sheet.getDataRange().getValues();
    const now = new Date();
    Object.keys(normalized).forEach(function (key) {
      const settingKey = 'allocation.' + key;
      const row = values.findIndex(function (item, index) { return index > 0 && String(item[0]) === settingKey; });
      if (row === -1) throw new Error('Thiếu cấu hình ' + settingKey + ' trong tab Settings.');
      sheet.getRange(row + 1, 2).setValue(normalized[key] / 100);
      sheet.getRange(row + 1, 4).setValue(now);
    });
    SpreadsheetApp.flush();
    return normalized;
  });
}

function getRates_() {
  const settings = readObjects_(CONFIG.sheets.settings);
  const values = {};
  settings.forEach(function (row) { values[String(row.Key)] = row.Value; });
  return {
    spending: percentage_(values['allocation.spending']),
    emergency: percentage_(values['allocation.emergency']),
    savings: percentage_(values['allocation.savings']),
    investment: percentage_(values['allocation.investment']),
  };
}

function calculateAllocations_(amount, rates, debtRemaining) {
  const debt = Math.min(amount, Math.max(0, toNumber_(debtRemaining)));
  const distributable = amount - debt;
  const result = { debt: debt };
  let allocatedOutsideSpending = 0;
  ['emergency', 'savings', 'investment'].forEach(function (key) {
    result[key] = Math.round(distributable * rates[key] / 100);
    allocatedOutsideSpending += result[key];
  });
  result.spending = distributable - allocatedOutsideSpending;
  return result;
}

function studentToClient_(row) {
  return {
    id: studentNumericId_(row.Student_ID),
    key: String(row.Student_ID),
    name: String(row.Full_Name || ''),
    phone: String(row.Phone || ''),
    plan: String(row.Plan_Name || ''),
    fee: toNumber_(row.Fee),
    start: dateOnly_(row.Start_Date),
    end: dateOnly_(row.End_Date),
    due: dateOnly_(row.Due_Date),
    status: statusToClient_(row.Status),
    note: String(row.Notes || ''),
    sessionsTotal: toNumber_(row.Total_Sessions),
    sessionsUsed: toNumber_(row.Sessions_Used),
    sessionsRemaining: toNumber_(row.Sessions_Remaining),
    lowSessionAlertAt: row.Low_Session_Alert_At ? dateTime_(row.Low_Session_Alert_At) : '',
    membership: row.Membership_State ? membershipToClient_(row.Membership_State) : statusToClient_(row.Status) === 'paused' ? 'stopped' : 'maintained',
  };
}

function recordAttendance_(studentId) {
  return withWriteLock_(function () {
    const sheet = getRequiredSheet_(CONFIG.sheets.students);
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(String);
    const index = headerIndex_(headers);
    const studentKey = normalizeStudentKey_(studentId);
    const rowOffset = values.findIndex(function (row, rowIndex) { return rowIndex > 0 && String(row[index.Student_ID]) === studentKey; });
    if (rowOffset === -1) throw new Error('Không tìm thấy học viên ' + studentKey + '.');

    const row = values[rowOffset];
    if (membershipToClient_(row[index.Membership_State]) === 'stopped') throw new Error('Học viên đã ngừng tập. Hãy chuyển sang Duy trì trước khi điểm danh.');
    const total = Math.max(0, toNumber_(row[index.Total_Sessions]));
    const used = Math.max(0, toNumber_(row[index.Sessions_Used]));
    if (!total) throw new Error('Học viên chưa được nhập tổng số buổi.');
    if (used >= total) throw new Error('Gói tập đã hết buổi.');
    const newUsed = used + 1;
    const remaining = Math.max(0, total - newUsed);
    const sheetRow = rowOffset + 1;
    const now = new Date();
    sheet.getRange(sheetRow, index.Sessions_Used + 1).setValue(newUsed);
    sheet.getRange(sheetRow, index.Sessions_Remaining + 1).setValue(remaining);
    sheet.getRange(sheetRow, index.Updated_At + 1).setValue(now);

    let telegramSent = false;
    let telegramError = '';
    if (remaining === 2 && !row[index.Low_Session_Alert_At]) {
      try {
        sendLowSessionTelegram_({
          name: row[index.Full_Name],
          phone: row[index.Phone],
          plan: row[index.Plan_Name],
          end: row[index.End_Date],
          remaining: remaining,
        });
        sheet.getRange(sheetRow, index.Low_Session_Alert_At + 1).setValue(now);
        telegramSent = true;
      } catch (error) {
        telegramError = error.message || String(error);
        console.error('Điểm danh đã lưu nhưng Telegram chưa gửi được: ' + telegramError);
      }
    }
    SpreadsheetApp.flush();
    return { studentId: studentKey, sessionsUsed: newUsed, sessionsRemaining: remaining, telegramSent: telegramSent, telegramError: telegramError };
  });
}

function checkLowSessionAlerts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;
  try {
    const sheet = getRequiredSheet_(CONFIG.sheets.students);
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(String);
    const index = headerIndex_(headers);
    const now = new Date();
    for (let i = 1; i < values.length; i += 1) {
      const row = values[i];
      if (!row[index.Student_ID] || membershipToClient_(row[index.Membership_State]) === 'stopped' || toNumber_(row[index.Sessions_Remaining]) !== 2 || row[index.Low_Session_Alert_At]) continue;
      sendLowSessionTelegram_({ name: row[index.Full_Name], phone: row[index.Phone], plan: row[index.Plan_Name], end: row[index.End_Date], remaining: 2 });
      sheet.getRange(i + 1, index.Low_Session_Alert_At + 1).setValue(now);
    }
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
}

function installDailyTelegramTrigger() {
  ScriptApp.getProjectTriggers().filter(function (trigger) { return trigger.getHandlerFunction() === 'checkLowSessionAlerts'; }).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('checkLowSessionAlerts').timeBased().everyDays(1).atHour(8).create();
}

function sendLowSessionTelegram_(student) {
  const properties = PropertiesService.getScriptProperties();
  const botToken = properties.getProperty('TELEGRAM_BOT_TOKEN');
  const chatId = properties.getProperty('TELEGRAM_CHAT_ID');
  if (!botToken || !chatId) throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID.');
  const text = [
    '🧘 <b>TrinhNYoga · Học viên còn 2 buổi</b>',
    '',
    '<b>Học viên:</b> ' + telegramEscape_(student.name),
    '<b>Số điện thoại:</b> ' + telegramEscape_(student.phone),
    '<b>Gói tập:</b> ' + telegramEscape_(student.plan),
    '<b>Ngày kết thúc:</b> ' + telegramEscape_(dateOnly_(student.end)),
    '<b>Số buổi còn lại:</b> ' + student.remaining,
    '',
    'Trinh chủ động liên hệ học viên để gia hạn nhé.',
  ].join('\n');
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
    method: 'post',
    payload: { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() >= 300) throw new Error('Telegram gửi thất bại: ' + response.getContentText().slice(0, 200));
}

function getDebtSummary_(date) {
  const target = getSettingNumber_('debt.monthly_target', 3000000);
  const monthKey = Utilities.formatDate(date, CONFIG.timezone, 'yyyy-MM');
  const allocated = readObjects_(CONFIG.sheets.allocations).reduce(function (sum, row) {
    if (String(row.Fund_Key) !== 'debt' || !row.Created_At) return sum;
    const rowMonth = Utilities.formatDate(row.Created_At instanceof Date ? row.Created_At : parseDate_(row.Created_At), CONFIG.timezone, 'yyyy-MM');
    return rowMonth === monthKey ? sum + toNumber_(row.Amount) : sum;
  }, 0);
  return { target: target, allocated: allocated, remaining: Math.max(0, target - allocated) };
}

function getSettingNumber_(key, fallback) {
  const row = readObjects_(CONFIG.sheets.settings).find(function (item) { return String(item.Key) === key; });
  return row ? toNumber_(row.Value) : fallback;
}

function headerIndex_(headers) {
  return headers.reduce(function (map, header, index) { map[header] = index; return map; }, {});
}

function telegramEscape_(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readObjects_(sheetName) {
  const values = getRequiredSheet_(sheetName).getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).filter(function (row) { return row[0] !== '' && row[0] !== null; }).map(function (row) {
    return headers.reduce(function (object, header, index) { object[header] = row[index]; return object; }, {});
  });
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Chưa cấu hình Script Property SPREADSHEET_ID.');
  return SpreadsheetApp.openById(id);
}

function getRequiredSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Không tìm thấy tab ' + name + '.');
  return sheet;
}

function assertAuthorized_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected || expected.length < 12) throw new Error('API_TOKEN chưa được cấu hình an toàn trong Script Properties.');
  if (!token || !constantTimeEquals_(String(token), expected)) throw new Error('Không có quyền truy cập database.');
}

function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function withWriteLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Hệ thống đang xử lý một giao dịch khác. Vui lòng thử lại.');
  try { return callback(); } finally { lock.releaseLock(); }
}

function nextPrefixedId_(ids, prefix, digits) {
  const max = ids.reduce(function (current, id) {
    const number = Number(String(id || '').replace(/\D/g, ''));
    return Number.isFinite(number) ? Math.max(current, number) : current;
  }, 0);
  return prefix + String(max + 1).padStart(digits, '0');
}

function nextPaymentId_(payments, date) {
  const day = Utilities.formatDate(date, CONFIG.timezone, 'MMdd');
  const sequence = payments.reduce(function (max, row) {
    const match = String(row.Payment_ID || '').match(/-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  return 'PT-' + day + '-' + String(sequence).padStart(3, '0');
}

function normalizeStudentKey_(value) {
  const text = String(value || '');
  if (/^HV-\d+$/.test(text)) return text;
  const number = Number(text.replace(/\D/g, ''));
  if (!number) throw new Error('Mã học viên không hợp lệ.');
  return 'HV-' + String(number).padStart(4, '0');
}

function studentNumericId_(value) {
  return Number(String(value || '').replace(/\D/g, '')) || 0;
}

function statusToClient_(status) {
  const map = { 'Đang học': 'active', 'Đến hạn': 'due', 'Quá hạn': 'overdue', 'Sắp hết gói': 'expiring', 'Tạm dừng': 'paused' };
  return map[String(status)] || 'active';
}

function clientStatusToSheet_(status) {
  const map = { active: 'Đang học', due: 'Đến hạn', overdue: 'Quá hạn', expiring: 'Sắp hết gói' };
  const normalized = map[String(status)];
  if (!normalized) throw new Error('Trạng thái học viên không hợp lệ.');
  return normalized;
}

function membershipToClient_(value) {
  return String(value) === 'Ngừng tập' ? 'stopped' : 'maintained';
}

function membershipToSheet_(value) {
  const map = { maintained: 'Duy trì', stopped: 'Ngừng tập', 'Duy trì': 'Duy trì', 'Ngừng tập': 'Ngừng tập' };
  const normalized = map[String(value)];
  if (!normalized) throw new Error('Tình trạng tập không hợp lệ.');
  return normalized;
}

function percentage_(value) {
  const number = toNumber_(value);
  return number <= 1 ? Math.round(number * 100) : Math.round(number);
}

function validateRates_(rates) {
  Object.keys(CONFIG.fundNames).forEach(function (key) {
    if (!Number.isFinite(rates[key]) || rates[key] < 0 || rates[key] > 100) throw new Error('Tỷ lệ ' + key + ' không hợp lệ.');
  });
  const total = Object.keys(CONFIG.fundNames).reduce(function (sum, key) { return sum + rates[key]; }, 0);
  if (Math.abs(total - 100) > 0.001) throw new Error('Tổng tỷ lệ phân bổ phải bằng 100%.');
}

function requireFields_(input, fields) {
  fields.forEach(function (field) {
    if (input[field] === undefined || input[field] === null || input[field] === '') throw new Error('Thiếu trường bắt buộc: ' + field);
  });
}

function positiveMoney_(value) {
  const amount = Math.round(toNumber_(value));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Số tiền phải lớn hơn 0.');
  return amount;
}

function toNumber_(value) {
  if (typeof value === 'number') return value;
  return Number(String(value === undefined || value === null ? '' : value).replace(/[^\d.-]/g, '')) || 0;
}

function cleanText_(value, maxLength) {
  return String(value || '').trim().replace(/[<>]/g, '').slice(0, maxLength);
}

function parseDate_(value) {
  if (value instanceof Date && !isNaN(value)) return value;
  const text = String(value || '').trim();
  const date = /^\d{4}-\d{2}-\d{2}/.test(text) ? new Date(text.slice(0, 10) + 'T00:00:00+07:00') : new Date(text);
  if (isNaN(date)) throw new Error('Ngày không hợp lệ: ' + value);
  return date;
}

function addMonths_(date, months) {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + Number(months));
  return result;
}

function dateOnly_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Utilities.formatDate(date, CONFIG.timezone, 'yyyy-MM-dd');
}

function isoNow_() {
  return Utilities.formatDate(new Date(), CONFIG.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function dateTime_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Utilities.formatDate(date, CONFIG.timezone, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
