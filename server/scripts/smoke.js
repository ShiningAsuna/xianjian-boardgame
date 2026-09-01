// 端到端冒烟测试 v2（适配《游戏规则.md》新版流程）：
//   注册账号 -> 创建人机房间(4人) -> Socket 加入并开局 ->
//   角色选择阶段自动弃置/轮选 -> 回合循环（事件/技牌/战斗8子阶段/补牌）->
//   监听 game_state 直到终局 -> 校验战绩接口。
// 所有引擎询问(pending)按简单策略自动响应。
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
  const name = `bot_smoke_${rnd()}`;
  const auth = await json('/api/auth/register', { method: 'POST', body: { username: name, password: '123456' } });
  console.log(`[1] registered ${auth.user.username} (uid=${auth.user.id})`);

  const room = await json('/api/rooms', {
    method: 'POST',
    body: { size: 4, mode: 'pve', pickConfig: { total: 8, open: 4 } },
  }, auth.token);
  console.log(`[2] room created: ${room.id} (pickConfig=${JSON.stringify(room.pickConfig)})`);

  const socket = io(BASE, { auth: { token: auth.token } });
  let latest = null;
  let errCount = 0;
  const lastLine = () => latest?.log?.[latest.log.length - 1]?.text || '';

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting game over, phase=${latest?.phase} battle=${latest?.battle?.stage} pending=${latest?.pending?.kind} last="${lastLine()}"`)), 240000);

    // ===== 引擎询问自动响应 =====
    function respondPending() {
      const p = latest?.pending;
      if (!p || p.kind === 'waiting') return;
      const uid = auth.user.id;
      let ans = null;
      switch (p.kind) {
        case 'choose_player': {
          const cands = p.data.candidates || [];
          ans = cands.length ? cands[0].id : null;
          break;
        }
        case 'yes_no':
        case 'use_card':
        case 'use_equip_burst':
        case 'use_pet_burst':
          ans = false; // 冒烟环境保守拒绝，倾慕者结算兜底
          break;
        case 'battle_confirm':
          ans = true;
          break;
        case 'pick_supporter':
        case 'pick_obstructer':
        case 'war_pick_player': {
          const cands = p.data.candidates || [];
          ans = cands.length ? cands[0].id : null;
          break;
        }
        case 'war_play_card': {
          const legal = p.data.legal || [];
          ans = legal.length ? { uid: legal[0].uid, targetSide: 'a' } : { pass: true };
          break;
        }
        default:
          ans = null;
      }
      socket.emit('submit_pending', { answer: ans });
    }

    // ===== 我方回合自动行动 =====
    async function pump() {
      if (!latest || latest.over) return;
      // 角色选择：轮到本阵营就选第一张可选的
      if (latest.phase === 'pick' && latest.pick?.currentSide === latest.you.faction) {
        const avail = latest.pick.pool.find((x) => x.owner === null);
        if (avail) socket.emit('pick_select', { key: avail.key });
        return;
      }
      if (latest.pending) return;
      if (latest.turnPlayerId !== auth.user.id) return;
      const hand = latest.you?.hand || [];
      switch (latest.phase) {
        case 'event':
          if (latest.deckLeft.event > 0 && Math.random() < 0.6) socket.emit('game_action', { type: 'draw_event' });
          else socket.emit('game_action', { type: 'skip_event' });
          break;
        case 'skill': {
          const equip = hand.find((c) => c.type === 2);
          if (equip) { socket.emit('game_action', { type: 'play_card', uid: equip.uid }); break; }
          const skill = hand.find((c) => c.type === 3);
          const others = latest.players.filter((p) => p.alive && p.id !== auth.user.id);
          if (skill && others.length) {
            socket.emit('game_action', { type: 'play_card', uid: skill.uid, targetId: others[0].id });
          } else {
            socket.emit('game_action', { type: 'go_battle' });
          }
          break;
        }
        case 'draw':
          socket.emit('game_action', { type: 'finish_turn' });
          break;
        default:
          break;
      }
    }

    socket.on('connect_error', (e) => reject(new Error('connect_error: ' + e.message)));
    socket.on('action_error', () => {
      errCount++;
      if (errCount > 30) reject(new Error(`too many action errors (${errCount})`));
    });

    let lastLen = -1;
    let tick = 0;
    socket.on('game_state', (st) => {
      latest = st;
      if (st.log?.length !== lastLen) {
        lastLen = st.log?.length || 0;
        const line = lastLine();
        if (line) console.log('   ·', line);
      }
      if (st.over) {
        clearTimeout(timer);
        resolve(st);
      }
    });

    // 心跳驱动（pending 响应 + 我方回合）
    const driver = setInterval(() => {
      tick++;
      if (!latest || latest.over) { clearInterval(driver); return; }
      respondPending();
      if (tick % 2 === 0) pump();
    }, 500);

    socket.emit('room_join', { roomId: room.id }, (r) => {
      if (!r.ok) { clearInterval(driver); return reject(new Error('room_join: ' + r.error)); }
      console.log('[3] joined room');
      socket.emit('start_game', {}, (rs) => {
        if (!rs.ok && rs.error && !/已经开局/.test(rs.error)) { clearInterval(driver); return reject(new Error(rs.error)); }
        console.log('[4] started');
      });
    });
  });

  console.log('='.repeat(60));
  console.log(`winner_faction = ${result.result.winnerFaction ?? '(平局)'}`);
  console.log(`scores = 蜀山派 ${result.result.scores.a} : 拜月教 ${result.result.scores.b}`);
  console.log(`reason = ${result.result.reason}`);
  console.log(`seats: ${result.players.map((p) => `${p.name}[${p.char?.name || '?'}]/${p.factionName}/宠物${p.pets.length}只${p.petScore}分/${p.alive ? '存活' : '阵亡'}`).join(' | ')}`);
  if (!result.players.every((p) => p.char)) throw new Error('存在未分配角色的玩家');

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
