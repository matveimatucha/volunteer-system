/**
 * Базовый URL API. Пустая строка = тот же домен (/api/...).
 * Если сайт на Firebase Hosting, а API на VPS — задайте, например:
 *   window.API_BASE = 'https://api.ваш-домен.ru';
 */
(function () {
    window.API_BASE = window.API_BASE || '';
    window.apiUrl = function (path) {
        const p = path.startsWith('/') ? path : '/' + path;
        return window.API_BASE + p;
    };
})();
