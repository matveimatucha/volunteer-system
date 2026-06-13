const { startRegistrationWatcher } = require('./telegram-notify');

function startWatchers(db, log = console) {
    startRegistrationWatcher(db, log);
}

module.exports = { startWatchers };
