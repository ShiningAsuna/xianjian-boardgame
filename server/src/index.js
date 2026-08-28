const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const config = require('./config');
const { router: authRouter } = require('./routes/auth');
const apiRouter = require('./routes/api');
const setupSocket = require('./socket');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api', apiRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'xianjian-server' }));

// 生产模式：若 client 已构建（client/dist），由后端直接托管静态页面
const distDir = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
setupSocket(io);

server.listen(config.PORT, () => {
  console.log(`[xianjian] server listening on http://localhost:${config.PORT}`);
});
