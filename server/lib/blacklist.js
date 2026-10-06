const { extractCommonFields, normalizeEmail, normalizePhone } = require('./registration-helpers');
const {
    normalizeText,
    normalizeCourse,
    nameTokens,
    nameRelation,
    facultyCompatible
} = require('./hours-import');

const MAX_REASON = 1000;

function personIdentity(source) {
    const common = source && source.answersLabeled
        ? extractCommonFields(source.answersLabeled)
        : {
            name: source && source.name || '',
            faculty: source && source.faculty || '',
            year: source && source.year || ''
        };
    const name = common.name || (source && source.name) || '';
    const faculty = common.faculty || (source && source.faculty) || '';
    const year = common.year || (source && source.year) || '';
    return {
        name,
        faculty,
        year,
        email: normalizeEmail((source && (source.contactEmail || source.email)) || ''),
        phone: normalizePhone((source && (source.contactPhone || source.phone)) || ''),
        nameTokens: nameTokens(name),
        facultyNorm: normalizeText(faculty),
        courseNorm: normalizeCourse(year)
    };
}

function samePerson(left, right) {
    if (left.email && right.email && left.email === right.email) return true;
    if (left.phone && right.phone && left.phone === right.phone) return true;
    if (!left.courseNorm || left.courseNorm !== right.courseNorm) return false;
    const relation = nameRelation(left.nameTokens, right.nameTokens);
    if (relation !== 'exact' && relation !== 'partial') return false;
    return left.facultyNorm === right.facultyNorm || facultyCompatible(left.facultyNorm, right.facultyNorm);
}

function publicEntry(entry) {
    const titles = Array.isArray(entry.eventTitles) ? entry.eventTitles.filter(Boolean) : [];
    return {
        id: entry.id,
        name: entry.name || '',
        faculty: entry.faculty || '',
        year: entry.year || '',
        email: entry.email || '',
        phone: entry.phone || '',
        reason: entry.reason || '',
        eventTitles: titles,
        updatedAt: entry.updatedAt || entry.createdAt || ''
    };
}

function findBlacklistHits(entries, source) {
    const identity = personIdentity(source);
    return (entries || [])
        .filter(entry => samePerson(identity, personIdentity(entry)))
        .map(publicEntry);
}

function mergeReason(existing, addition) {
    const next = String(addition || '').trim().slice(0, MAX_REASON);
    const prev = String(existing || '').trim();
    if (!next) return prev.slice(0, 4000);
    if (prev.split('\n').some(line => line.trim() === next)) return prev.slice(0, 4000);
    return (prev ? `${prev}\n${next}` : next).slice(0, 4000);
}

function entryFromRegistration(reg, registrationId, reason, addedBy) {
    const identity = personIdentity(reg);
    const eventTitle = reg.eventTitle || '';
    const now = new Date().toISOString();
    return {
        name: identity.name,
        faculty: identity.faculty,
        year: identity.year,
        email: identity.email,
        phone: identity.phone,
        reason: mergeReason('', reason),
        eventTitles: eventTitle ? [eventTitle] : [],
        registrationId: registrationId || '',
        createdAt: now,
        updatedAt: now,
        addedBy: addedBy || ''
    };
}

function applyReason(entry, reg, registrationId, reason) {
    const eventTitle = (reg && reg.eventTitle) || '';
    const titles = Array.isArray(entry.eventTitles) ? entry.eventTitles.slice() : [];
    if (eventTitle && !titles.includes(eventTitle)) titles.push(eventTitle);
    return {
        reason: mergeReason(entry.reason, reason),
        eventTitles: titles,
        registrationId: registrationId || entry.registrationId || '',
        updatedAt: new Date().toISOString()
    };
}

module.exports = {
    MAX_REASON,
    personIdentity,
    samePerson,
    findBlacklistHits,
    mergeReason,
    entryFromRegistration,
    applyReason,
    publicEntry
};
