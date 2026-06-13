module.exports = {
    apps: [{
        name: 'volunteer',
        cwd: __dirname,
        script: 'index.js',
        instances: 1,
        autorestart: true,
        max_memory_restart: '250M',
        min_uptime: '10s',
        max_restarts: 15,
        restart_delay: 3000,
        exp_backoff_restart_delay: 1000,
        env: {
            NODE_ENV: 'production',
            PORT: 3000
        }
    }]
};
