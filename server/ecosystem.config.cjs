module.exports = {
    apps: [{
        name: 'volunteer',
        cwd: __dirname,
        script: 'index.js',
        instances: 1,
        autorestart: true,
        max_memory_restart: '300M',
        env: {
            NODE_ENV: 'production',
            PORT: 3000
        }
    }]
};
