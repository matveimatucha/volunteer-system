const { extractCommonFields, isConfirmedRegistration } = require('./registration-helpers');

const MAX_IMPORT_ROWS = 5000;
const MAX_COMMENT = 1000;

const COURSE_WORDS = {
    первый: '1',
    второй: '2',
    третий: '3',
    четвертый: '4',
    пятый: '5',
    шестой: '6',
    седьмой: '7'
};

function normalizeText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[«»"'`]/g, '')
        .replace(/[./,;:!?()[\]{}\\|_+-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeCourse(value) {
    const text = normalizeText(value);
    if (!text) return '';
    if (COURSE_WORDS[text]) return COURSE_WORDS[text];
    const first = text.split(' ')[0];
    if (COURSE_WORDS[first]) return COURSE_WORDS[first];
    const digits = text.match(/\d+/);
    if (digits) return String(parseInt(digits[0], 10));
    return text;
}

function nameTokens(value) {
    return normalizeText(value).split(' ').filter(token => token.length > 1);
}

function parseHoursCell(value) {
    if (value == null) return { hours: null, error: '' };
    if (typeof value === 'number') return checkHours(value);
    const text = String(value).trim().replace(',', '.');
    if (!text) return { hours: null, error: '' };
    if (!/^\d+(\.\d+)?$/.test(text)) return { hours: null, error: 'В колонке «Часы» нужно число от 0 до 72, шаг 0,5' };
    return checkHours(Number(text));
}

function checkHours(hours) {
    if (!Number.isFinite(hours) || hours < 0 || hours > 72) {
        return { hours: null, error: 'Часы должны быть от 0 до 72' };
    }
    const doubled = Math.round(hours * 2);
    if (Math.abs(hours * 2 - doubled) > 1e-6) {
        return { hours: null, error: 'Часы указываются с шагом 0,5' };
    }
    if (doubled === 0) return { hours: null, error: '' };
    return { hours: doubled / 2, error: '' };
}

function facultyCompatible(left, right) {
    if (left === right) return true;
    const short = left.length <= right.length ? left : right;
    const long = left.length <= right.length ? right : left;
    if (short.length < 5) return false;
    return long.includes(short);
}

function nameRelation(rowTokens, regTokens) {
    if (!rowTokens.length || !regTokens.length) return 'none';
    const rowSet = new Set(rowTokens);
    const regSet = new Set(regTokens);
    const sameSize = rowTokens.length === regTokens.length;
    const rowInReg = rowTokens.every(token => regSet.has(token));
    const regInRow = regTokens.every(token => rowSet.has(token));
    if (sameSize && rowInReg && regInRow) return 'exact';
    const short = rowTokens.length < regTokens.length ? rowTokens : regTokens;
    const longSet = rowTokens.length < regTokens.length ? regSet : rowSet;
    if (short.length >= 2 && short.length < (rowTokens.length < regTokens.length ? regTokens.length : rowTokens.length)) {
        if (short.every(token => longSet.has(token))) return 'partial';
    }
    return 'none';
}

function registrationProfile(reg) {
    const common = extractCommonFields(reg.answersLabeled);
    return {
        registrationId: reg.registrationId,
        name: common.name || '',
        faculty: common.faculty || '',
        year: common.year || '',
        nameTokens: nameTokens(common.name),
        facultyNorm: normalizeText(common.faculty),
        courseNorm: normalizeCourse(common.year)
    };
}

function publicCandidate(profile) {
    return {
        registrationId: profile.registrationId,
        name: profile.name,
        faculty: profile.faculty,
        year: profile.year
    };
}

function matchRow(row, profiles) {
    const tokens = nameTokens(row.name);
    const faculty = normalizeText(row.faculty);
    const course = normalizeCourse(row.year);
    const scored = [];

    for (const profile of profiles) {
        if (profile.courseNorm !== course) continue;
        const relation = nameRelation(tokens, profile.nameTokens);
        if (relation === 'none') continue;
        const facultyExact = profile.facultyNorm === faculty;
        if (!facultyExact && !facultyCompatible(faculty, profile.facultyNorm)) continue;
        scored.push({ profile, relation, facultyExact });
    }

    const pick = (list) => list.map(item => item.profile);

    const exact = pick(scored.filter(item => item.relation === 'exact' && item.facultyExact));
    if (exact.length === 1) return { profile: exact[0], candidates: exact };
    if (exact.length > 1) return { profile: null, candidates: exact };

    const exactName = pick(scored.filter(item => item.relation === 'exact'));
    if (exactName.length === 1) return { profile: exactName[0], candidates: exactName };
    if (exactName.length > 1) return { profile: null, candidates: exactName };

    const partialExactFaculty = pick(scored.filter(item => item.relation === 'partial' && item.facultyExact));
    if (partialExactFaculty.length === 1) return { profile: partialExactFaculty[0], candidates: partialExactFaculty };
    if (partialExactFaculty.length > 1) return { profile: null, candidates: partialExactFaculty };

    const partial = pick(scored.filter(item => item.relation === 'partial'));
    if (partial.length === 1) return { profile: partial[0], candidates: partial };
    if (partial.length > 1) return { profile: null, candidates: partial };

    return { profile: null, candidates: [] };
}

function sanitizeImportRows(raw) {
    if (!Array.isArray(raw)) return { error: 'Нет строк файла' };
    if (raw.length > MAX_IMPORT_ROWS) return { error: 'В файле больше 5000 строк' };
    const rows = raw.map((row, index) => {
        const source = row && typeof row === 'object' ? row : {};
        const rawHours = source.hoursRaw != null && source.hoursRaw !== '' ? source.hoursRaw : source.hours;
        const parsed = parseHoursCell(rawHours);
        const excelRow = Number(source.row);
        return {
            row: Number.isInteger(excelRow) && excelRow > 0 ? excelRow : index + 2,
            name: String(source.name ?? '').slice(0, 300),
            faculty: String(source.faculty ?? '').slice(0, 300),
            year: String(source.year ?? '').slice(0, 80),
            hours: parsed.hours,
            hoursRaw: rawHours == null ? '' : rawHours,
            hoursError: parsed.error,
            comment: String(source.comment ?? '').trim().slice(0, MAX_COMMENT)
        };
    });
    return { rows };
}

function sanitizeChoices(raw) {
    const choices = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return choices;
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value && value.length <= 128) choices[String(key)] = value;
    }
    return choices;
}

function buildHoursPreview(registrations, rows, choices) {
    const confirmed = (registrations || []).filter(isConfirmedRegistration).map(registrationProfile);
    const byId = new Map(confirmed.map(profile => [profile.registrationId, profile]));
    const selected = choices || {};
    const draft = rows.map(row => {
        const base = {
            row: row.row,
            name: row.name,
            faculty: row.faculty,
            year: row.year,
            hours: row.hours,
            comment: row.comment,
            registrationId: null,
            candidates: [],
            status: 'unknown',
            message: ''
        };
        if (row.hoursError) {
            base.status = 'invalid';
            base.message = row.hoursError;
            return base;
        }
        const found = matchRow(row, confirmed);
        base.candidates = found.candidates.map(publicCandidate);
        let profile = found.profile;
        if (!profile && found.candidates.length > 1) {
            const chosenId = selected[String(row.row)];
            profile = found.candidates.find(candidate => candidate.registrationId === chosenId) || null;
        }
        if (profile) {
            base.registrationId = profile.registrationId;
            base.status = row.hours == null ? 'absent' : 'present';
            base.message = row.hours == null
                ? 'Нет часов — неявка'
                : `Записать ${row.hours} ч`;
            return base;
        }
        if (found.candidates.length > 1) {
            base.status = 'ambiguous';
            base.message = 'Несколько человек с такими ФИО, факультетом и курсом — выберите, кому записать';
            return base;
        }
        base.status = 'unknown';
        base.message = 'Такого записанного нет, строка будет пропущена';
        return base;
    });

    const owners = new Map();
    draft.forEach(row => {
        if (!row.registrationId) return;
        if (!owners.has(row.registrationId)) owners.set(row.registrationId, []);
        owners.get(row.registrationId).push(row);
    });
    for (const group of owners.values()) {
        if (group.length < 2) continue;
        group.forEach(row => {
            row.status = 'conflict';
            row.registrationId = null;
            row.message = 'Этот человек указан в нескольких строках';
        });
    }

    const covered = new Set(draft.filter(row => row.registrationId).map(row => row.registrationId));
    const pending = new Set();
    draft.forEach(row => {
        if (row.status === 'invalid') {
            const found = matchRow(row, confirmed);
            if (found.profile) pending.add(found.profile.registrationId);
            found.candidates.forEach(candidate => pending.add(candidate.registrationId));
        }
        if (row.status === 'ambiguous') {
            row.candidates.forEach(candidate => pending.add(candidate.registrationId));
        }
        if (row.status === 'conflict') {
            row.candidates.forEach(candidate => pending.add(candidate.registrationId));
        }
    });

    const updates = [];
    draft.forEach(row => {
        if (!row.registrationId || (row.status !== 'present' && row.status !== 'absent')) return;
        updates.push({
            registrationId: row.registrationId,
            attendance: row.status === 'present' ? 'present' : 'absent',
            workedHours: row.status === 'present' ? row.hours : null,
            updateComment: true,
            coordinatorNote: row.comment
        });
    });

    const missing = [];
    for (const profile of confirmed) {
        if (covered.has(profile.registrationId) || pending.has(profile.registrationId)) continue;
        missing.push(publicCandidate(profile));
        updates.push({
            registrationId: profile.registrationId,
            attendance: 'absent',
            workedHours: null,
            updateComment: false,
            coordinatorNote: ''
        });
    }

    const summary = {
        present: draft.filter(row => row.status === 'present').length,
        absent: draft.filter(row => row.status === 'absent').length + missing.length,
        unknown: draft.filter(row => row.status === 'unknown').length,
        ambiguous: draft.filter(row => row.status === 'ambiguous').length,
        invalid: draft.filter(row => row.status === 'invalid').length,
        conflict: draft.filter(row => row.status === 'conflict').length
    };
    const ready = summary.ambiguous === 0 && summary.invalid === 0 && summary.conflict === 0
        && updates.length === confirmed.length
        && updates.every(update => byId.has(update.registrationId));

    return { ready, summary, rows: draft, missing, updates };
}

module.exports = {
    MAX_COMMENT,
    normalizeText,
    normalizeCourse,
    nameTokens,
    parseHoursCell,
    registrationProfile,
    sanitizeImportRows,
    sanitizeChoices,
    buildHoursPreview,
    nameRelation,
    facultyCompatible
};
