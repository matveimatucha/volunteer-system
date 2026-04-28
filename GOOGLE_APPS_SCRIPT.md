# Google Apps Script v2: импорт + лог + уведомления + листы по мероприятиям

Эта версия делает все сразу:

- импорт CSV из папки Google Drive;
- дедупликация по `registrationId`;
- лист `import_log` (история запусков);
- уведомления в Telegram и/или на email при новых заявках;
- автоматическая разбивка по мероприятиям (лист на каждое событие);
- опциональный перенос обработанных CSV в архив.

## 1) Подготовьте таблицу и папки

1. В Google Sheets создайте таблицу.
2. Создайте папки на Google Drive:
  - `Volunteer CSV Inbox` (куда загружаете CSV с сайта),
  - `Volunteer CSV Archive` (опционально).
3. Скопируйте ID папок из URL.

## 2) Вставьте скрипт в Apps Script

Откройте `Extensions -> Apps Script`, вставьте код:

```javascript
const CONFIG = {
  RAW_SHEET: 'raw',
  LOG_SHEET: 'import_log',
  EVENT_SHEET_PREFIX: 'event_',
  INBOX_FOLDER_ID: 'PASTE_INBOX_FOLDER_ID',
  ARCHIVE_FOLDER_ID: 'PASTE_ARCHIVE_FOLDER_ID', // можно пустую строку
  MOVE_PROCESSED_FILES: true,

  ENABLE_TELEGRAM: false,
  TELEGRAM_BOT_TOKEN: 'PASTE_TELEGRAM_BOT_TOKEN',
  TELEGRAM_CHAT_ID: 'PASTE_TELEGRAM_CHAT_ID',

  ENABLE_EMAIL: false,
  EMAIL_RECIPIENTS: 'you@example.com', // через запятую

  MAX_TELEGRAM_LINES: 8
};

function importVolunteerCsvV2() {
  const startedAt = new Date();
  const lock = LockService.getScriptLock();
  lock.tryLock(30000);

  let processedCsvFiles = 0;
  let insertedRows = 0;
  let errors = 0;
  const eventCounters = {};
  const insertedPreview = [];

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rawSheet = getOrCreateSheet(ss, CONFIG.RAW_SHEET);
    const logSheet = getOrCreateSheet(ss, CONFIG.LOG_SHEET);

    ensureLogHeader(logSheet);
    let rawHeader = getSheetHeader(rawSheet);
    const existingIds = getExistingIds(rawSheet);

    const inbox = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);
    const archive = CONFIG.ARCHIVE_FOLDER_ID ? DriveApp.getFolderById(CONFIG.ARCHIVE_FOLDER_ID) : null;

    const files = inbox.getFiles();

    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();
      if (!fileName.toLowerCase().endsWith('.csv')) continue;

      try {
        const csvText = file.getBlob().getDataAsString('UTF-8');
        const rows = Utilities.parseCsv(csvText);
        if (!rows || rows.length < 2) {
          processedCsvFiles += 1;
          archiveFileIfNeeded(file, inbox, archive);
          continue;
        }

        const fileHeader = rows[0].map(safeCell);
        requireColumns(fileHeader, ['registrationId', 'eventId', 'eventTitle']);
        rawHeader = ensureRawHeader(rawSheet, rawHeader, fileHeader);

        const dataRows = rows.slice(1);
        const newObjects = [];

        dataRows.forEach((row) => {
          const obj = rowToObject(fileHeader, row);
          const regId = safeCell(obj.registrationId);
          if (!regId) return;
          if (existingIds.has(regId)) return;

          existingIds.add(regId);
          newObjects.push(obj);
        });

        if (newObjects.length > 0) {
          appendObjects(rawSheet, rawHeader, newObjects);
          insertedRows += newObjects.length;

          const eventGroups = splitByEvent(newObjects);
          Object.keys(eventGroups).forEach((eventKey) => {
            const eventSheetName = buildEventSheetName(eventKey);
            const eventSheet = getOrCreateSheet(ss, eventSheetName);
            ensureSheetHeader(eventSheet, rawHeader);
            appendObjects(eventSheet, rawHeader, eventGroups[eventKey]);
            eventCounters[eventKey] = (eventCounters[eventKey] || 0) + eventGroups[eventKey].length;
          });

          insertedPreview.push(...newObjects.slice(0, 50));
        }

        processedCsvFiles += 1;
        archiveFileIfNeeded(file, inbox, archive);
      } catch (fileError) {
        errors += 1;
        logFileError(fileName, fileError);
      }
    }

    writeImportLog(logSheet, {
      startedAt,
      processedCsvFiles,
      insertedRows,
      errors,
      eventCounters
    });

    if (insertedRows > 0) {
      sendNotifications({
        insertedRows,
        processedCsvFiles,
        eventCounters,
        preview: insertedPreview
      });
    }
  } finally {
    lock.releaseLock();
  }
}

function sendNotifications(context) {
  const summaryLines = buildSummaryLines(context);

  if (CONFIG.ENABLE_TELEGRAM) {
    sendTelegram(summaryLines.join('\n'));
  }
  if (CONFIG.ENABLE_EMAIL) {
    sendEmail(summaryLines, context);
  }
}

function buildSummaryLines(context) {
  const tz = Session.getScriptTimeZone();
  const now = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
  const lines = [
    'New volunteer registrations imported',
    `Time: ${now}`,
    `CSV files: ${context.processedCsvFiles}`,
    `Inserted rows: ${context.insertedRows}`,
    ''
  ];

  const eventEntries = Object.entries(context.eventCounters);
  if (eventEntries.length > 0) {
    lines.push('By event:');
    eventEntries
      .sort((a, b) => b[1] - a[1])
      .forEach(([eventKey, count]) => lines.push(`- ${eventKey}: ${count}`));
    lines.push('');
  }

  lines.push('Preview:');
  context.preview.slice(0, CONFIG.MAX_TELEGRAM_LINES).forEach((item) => {
    lines.push(`- ${safeCell(item.eventTitle)} | ${safeCell(item.registrationId)} | ${safeCell(item.timestamp)}`);
  });
  return lines;
}

function sendTelegram(text) {
  const token = safeCell(CONFIG.TELEGRAM_BOT_TOKEN);
  const chatId = safeCell(CONFIG.TELEGRAM_CHAT_ID);
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    payload: {
      chat_id: chatId,
      text
    },
    muteHttpExceptions: true
  });
}

function sendEmail(lines, context) {
  const recipients = safeCell(CONFIG.EMAIL_RECIPIENTS);
  if (!recipients) return;

  const subject = `[Volunteer] New registrations: ${context.insertedRows}`;
  const body = lines.join('\n');
  MailApp.sendEmail({
    to: recipients,
    subject,
    body
  });
}

function splitByEvent(objects) {
  const result = {};
  objects.forEach((obj) => {
    const eventId = safeCell(obj.eventId) || 'no_event_id';
    const eventTitle = safeCell(obj.eventTitle) || 'no_event_title';
    const key = `${eventId}__${eventTitle}`;
    if (!result[key]) result[key] = [];
    result[key].push(obj);
  });
  return result;
}

function buildEventSheetName(eventKey) {
  const clean = eventKey
    .replace(/[\\\/\?\*\[\]\:]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const base = `${CONFIG.EVENT_SHEET_PREFIX}${clean}`;
  return base.length > 95 ? base.slice(0, 95) : base;
}

function writeImportLog(logSheet, payload) {
  const tz = Session.getScriptTimeZone();
  const started = Utilities.formatDate(payload.startedAt, tz, 'yyyy-MM-dd HH:mm:ss');
  const eventSummary = Object.entries(payload.eventCounters)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');

  const row = [
    started,
    payload.processedCsvFiles,
    payload.insertedRows,
    payload.errors,
    payload.insertedRows > 0 ? 'imported' : 'no_new_rows',
    eventSummary
  ];

  logSheet.appendRow(row);
}

function ensureLogHeader(logSheet) {
  const header = getSheetHeader(logSheet);
  if (header.length > 0) return;
  logSheet.appendRow(['runAt', 'processedCsvFiles', 'insertedRows', 'errors', 'status', 'eventSummary']);
}

function getExistingIds(sheet) {
  const ids = new Set();
  if (sheet.getLastRow() < 2) return ids;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  values.forEach(([id]) => {
    const normalized = safeCell(id);
    if (normalized) ids.add(normalized);
  });
  return ids;
}

function appendObjects(sheet, header, objects) {
  if (!objects.length) return;
  const rows = objects.map((obj) => header.map((key) => obj[key] || ''));
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rows.length, header.length).setValues(rows);
}

function rowToObject(header, row) {
  const obj = {};
  header.forEach((col, i) => {
    obj[col] = safeCell(row[i]);
  });
  return obj;
}

function ensureRawHeader(rawSheet, currentHeader, fileHeader) {
  let finalHeader = currentHeader.slice();

  if (finalHeader.length === 0) {
    finalHeader = fileHeader.slice();
    rawSheet.getRange(1, 1, 1, finalHeader.length).setValues([finalHeader]);
    return finalHeader;
  }

  const missing = fileHeader.filter((col) => !finalHeader.includes(col));
  if (missing.length > 0) {
    finalHeader = finalHeader.concat(missing);
    rawSheet.getRange(1, 1, 1, finalHeader.length).setValues([finalHeader]);
  }

  return finalHeader;
}

function ensureSheetHeader(sheet, header) {
  const current = getSheetHeader(sheet);
  if (current.length === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    return;
  }
  if (current.join('||') !== header.join('||')) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function getSheetHeader(sheet) {
  if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
  const values = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return values.map(safeCell).filter((v) => v !== '');
}

function requireColumns(header, required) {
  required.forEach((col) => {
    if (!header.includes(col)) {
      throw new Error(`CSV missing required column: ${col}`);
    }
  });
}

function archiveFileIfNeeded(file, inbox, archive) {
  if (!CONFIG.MOVE_PROCESSED_FILES || !archive) return;
  archive.addFile(file);
  inbox.removeFile(file);
}

function getOrCreateSheet(ss, name) {
  const existing = ss.getSheetByName(name);
  if (existing) return existing;
  return ss.insertSheet(name);
}

function logFileError(fileName, error) {
  console.error(`CSV import failed for ${fileName}: ${error && error.message ? error.message : error}`);
}

function safeCell(value) {
  return String(value == null ? '' : value).trim();
}
```

## 3) Что нужно настроить в CONFIG

- `INBOX_FOLDER_ID` обязательно.
- `ARCHIVE_FOLDER_ID` и `MOVE_PROCESSED_FILES` по желанию.
- Для Telegram:
  - `ENABLE_TELEGRAM = true`
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`
- Для email:
  - `ENABLE_EMAIL = true`
  - `EMAIL_RECIPIENTS` (можно несколько через запятую).

## 4) Первый запуск и расписание

1. Запустите вручную `importVolunteerCsvV2` (дать разрешения).
2. В `Triggers` создайте расписание для `importVolunteerCsvV2`:
  - `Time-driven`
  - например, каждые 15 минут или раз в час.

## 5) Что появится в таблице

- `raw` - все уникальные заявки.
- `import_log` - каждый запуск (когда, сколько файлов, сколько строк, ошибки).
- `event_<eventId>__<eventTitle>` - отдельные листы по каждому мероприятию.

## 6) Рекомендованный процесс

1. На сайте скачивайте `CSV (новые)` и кладите файл в `Volunteer CSV Inbox`.
2. Скрипт по расписанию загрузит данные.
3. Если включены уведомления, получите сводку в Telegram/email.

