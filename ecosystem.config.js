// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'whatsapp-api',
    script: 'index.js',
    cwd: '/home/leogonzaga/whatsapp-api',
    watch: false,
    env: {
      NODE_ENV: 'production'
    },
    // Logs gerenciados pelo pino, mas definimos arquivos separados para o PM2
    out_file: '/home/leogonzaga/whatsapp-api/logs/pm2-out.log',
    error_file: '/home/leogonzaga/whatsapp-api/logs/pm2-error.log'
  }]
};
