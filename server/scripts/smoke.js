// 端到端冒烟测试：
//   注册随机账号 -> 创建人机房间(4人) -> Socket 加入并开局 ->
//   监听 game_state 直到终局 -> 校验战绩接口。
// 运行前请用较小牌堆启动服务端，例如：
//   XJ_MONSTER_DECK_COPIES=1 node src/index.js （cmd 下见 package.json 的 smoke 脚本）
/* eslint-disable no-console */
const { io } = require('socket.io-client');

const BASE = 'http://localhost:3000';
const rnd = () => Math.random().toString(36).slice(2, 8);

async function json(path, opts = {}, token) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  // 1. 注册
  const name = `bot_smoke_${rnd()}`;
  const auth = await json('/api/auth/register', { method: 'POST', body: { username: name, password: '123456' } });
  console.log(`[1] registered ${auth.user.username} (uid=${auth.user.id})`);

  // 2. 创建 4 人人机房
  const room = await json('/api/rooms', { method: 'POST', body: { size: 4, mode: 'pve' } }, auth.token);
  console.log(`[2] room created: ${room.id} (${room.mode}, size=${room.size})`);

  // 3. 连接 socket，加入并开局
  const socket = io(BASE, { auth: { token: auth.token } });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting game over')), 180000);
    let lastLen = -1;
    let latest = null;
    let pumping = false;

    let errCount = 0;
    const send = (type, uid) => socket.emit('game_action', { type, uid });

    // 轮到本账号时按简化策略行动（模拟真人/前端行为）
    async function pump() {
      if (pumping || !latest) return;
      pumping = true;
      try {
        while (latest && !latest.over && latest.turnPlayerId === auth.user.id) {
          await wait(160);
          if (!latest || latest.over || latest.turnPlayerId !== auth.user.id) break;
          const phaseAtSend = latest.phase;
          switch (phaseAtSend) {
            case 'event': send('skip_event'); break;
            case 'skill': {
              const cardObj = handObjs().find((c) => c.kind === 'equip')
                || handObjs().find((c) => c.kind === 'instant');
              if (cardObj) send('play_card', cardObj.uid);
              else send('go_battle');
              break;
            }
            case 'battle': send('flip_monster'); break;
            case 'draw': send('finish_turn'); break;
            default: return;
          }
          await wait(220);
        }
      } finally {
        pumping = false;
      }
    }

    function handObjs() {
      return (latest && latest.you && latest.you.hand) || [];
    }

    socket.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
    socket.on('action_error', () => {
      errCount++;
      if (errCount > 20) reject(new Error(`too many action errors (${errCount})`));
    });

    socket.on('game_state', (st) => {
      if (st.log.length !== lastLen) {
        lastLen = st.log.length;
        const line = st.log[st.log.length - 1];
        if (line) console.log('   ·', line.text);
      }
      latest = st;
      pump();
      if (st.over) {
        clearTimeout(timer);
        resolve(st);
      }
    });

    socket.emit('room_join', { roomId: room.id }, (r) => {
      if (!r.ok) return reject(new Error('room_join: ' + r.error));
      console.log('[3] joined room');
      socket.emit('start_game', {}, (rs) => {
        if (!rs.ok && rs.error && !/已经开局/.test(rs.error)) return reject(new Error(rs.error));
        console.log('[4] started');
      });
    });
  });

  // 4. 终局摘要
  console.log('='.repeat(60));
  console.log(`winner_faction = ${result.result.winnerFaction ?? '(平局)'}`);
  console.log(`scores = 蜀山派 ${result.result.scores.a} : 拜月教 ${result.result.scores.b}`);
  console.log(`reason = ${result.result.reason}, monsterDeckLeft = ${result.deckLeft.monster}`);
  console.log(`seats: ${result.players.map((p) => `${p.name}/${p.factionName}/宠物${p.pets.length}只${p.petScore}分/${p.alive ? '存活' : '阵亡'}`).join(' | ')}`);

  if (!result.players.some((p) => p.isBot)) throw new Error('PVE 房间应包含 bot 座位');

  // 5. 战绩入库校验
  await wait(300);
  const matches = await json('/api/matches', {}, auth.token);
  if (!matches.length) throw new Error('matches 表为空，终局未持久化');
  console.log(`[5] matches persisted: total=${matches.length}, latest winner=${matches[0].winner_faction}`);

  socket.disconnect();
  console.log('SMOKE TEST PASSED [OK]');
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED:', e.message);
  process.exit(1);
});
