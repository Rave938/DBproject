require('dotenv').config();
const { connectDB } = require('./config/db');
const app = require('./app');
const os = require('os');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/survey_system';

(async () => {
  try {
    await connectDB(MONGO_URI);
    // 修改监听地址为 0.0.0.0，允许局域网访问
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n[server] 本地访问: http://localhost:${PORT}`);
      
      // 自动获取局域网 IP
      const interfaces = os.networkInterfaces();
      let localIp = '';
      for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
          const alias = iface[i];
          if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
            localIp = alias.address;
          }
        }
      }
      if (localIp) {
        console.log(`[server] 局域网访问: http://${localIp}:${PORT}\n`);
      }
    });
  } catch (err) {
    console.error('[server] 启动失败:', err.message);
    process.exit(1);
  }
})();