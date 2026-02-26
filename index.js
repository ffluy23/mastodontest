/**
 * index.js (single-file example)
 * Node.js battle engine + simple command parser (Mastodon integration stub)
 *
 * Assumptions:
 * - You can extract:
 *   - actor acct: status.account.acct  (e.g. "alice@mastodon.social")
 *   - actor display_name: status.account.display_name
 *   - mentions: status.mentions (array of { acct, ... })
 *   - text content: status.content OR status.text (depending on lib) -> we treat as plain text
 *
 * Commands (Korean):
 * - "@bot 전투 @userA @userB"  -> start battle
 * - "@bot 공격" | "@bot 방어" | "@bot 회피" -> choose action for current battle you are in
 */

'use strict';

// -----------------------------
// 0) Config / Constants
// -----------------------------
const ACTION = {
  ATTACK: 'attack',
  DEFEND: 'defend',
  EVADE: 'evade',
};

const ACTION_KO_TO_ENUM = new Map([
  ['공격', ACTION.ATTACK],
  ['방어', ACTION.DEFEND],
  ['회피', ACTION.EVADE],
]);

// 봇의 acct (커맨드 파싱에서 @bot 멘션 제거/무시용)
// 실제로는 네 봇 acct로 맞춰줘. 예: "mybot@your.instance"
const BOT_ACCT = 'bot@your.instance';

// -----------------------------
// 1) Character data (placeholder for 30 people)
// Later: replace loadCharacters() with Google Sheets loader + cache.
// Key MUST be mastodon acct (user@server)
// -----------------------------
function loadCharacters() {
  // 예시 2명
  // id = acct
  return new Map([
    ['sawa_2@mastodon.social', { id: 'sawa_2@mastodon.social', baseName: '사와', maxHp: 100, atk: 20, def: 10, agi: 15, speed: 18, crit: 0.10 }],
    ['sawa_@mastodon.social',  { id: 'sawa_@mastodon.social',  baseName: '사와 2',   maxHp: 90,  atk: 22, def: 9,  agi: 28, speed: 20, crit: 0.12 }],
  ]);
}

const characterStore = loadCharacters();

// -----------------------------
// 2) Utilities
// -----------------------------
function structuredCloneSafe(obj) {
  // Node 17+ has global structuredClone; fallback to JSON clone
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

function normalizeText(htmlOrText) {
  // 마스토돈 status.content는 HTML인 경우가 많아서 태그 제거
  // 완벽하진 않지만 간단히 쓰기엔 충분
  if (!htmlOrText) return '';
  return String(htmlOrText)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function pickDisplayName(accountLike, fallback) {
  const dn = accountLike?.display_name?.trim();
  if (dn) return dn;
  return fallback;
}

function makeBattleId(acctA, acctB) {
  return [acctA, acctB].sort().join('__');
}

function hpBar(hp, maxHp, width = 10) {
  const ratio = Math.max(0, Math.min(1, hp / maxHp));
  const filled = Math.round(ratio * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// -----------------------------
// 3) Battle Engine (Simultaneous declaration)
// -----------------------------
class Battle {
  constructor(playerA, playerB) {
    this.playerA = playerA;
    this.playerB = playerB;

    this.turnOrder = this.decideOrder(); // [first, second] by speed (+ random tie)
    this.actions = {
      [this.playerA.id]: null,
      [this.playerB.id]: null,
    };

    this.round = 1;
    this.isFinished = false;
    this.winnerId = null;
  }

  decideOrder() {
    const a = this.playerA;
    const b = this.playerB;
    if (a.speed > b.speed) return [a, b];
    if (b.speed > a.speed) return [b, a];
    return Math.random() < 0.5 ? [a, b] : [b, a];
  }

  getPlayer(id) {
    if (this.playerA.id === id) return this.playerA;
    if (this.playerB.id === id) return this.playerB;
    return null;
  }

  getOpponent(id) {
    if (this.playerA.id === id) return this.playerB;
    if (this.playerB.id === id) return this.playerA;
    return null;
  }

  setAction(playerId, action) {
    if (this.isFinished) {
      return { done: true, message: `이미 끝난 전투야.` };
    }
    if (!this.actions.hasOwnProperty(playerId)) {
      return { done: false, message: `너는 이 전투 참가자가 아니야.` };
    }
    if (!Object.values(ACTION).includes(action)) {
      return { done: false, message: `가능한 행동: 공격/방어/회피` };
    }

    this.actions[playerId] = action;

    if (!this.isReady()) {
      const other = this.getOpponent(playerId);
      const otherAction = this.actions[other.id];
      const waitMsg = otherAction
        ? `너도 선택했고 상대도 선택했어… 어? (이상함)` // 사실 여기 올 일 거의 없음
        : `행동 선택 완료. 상대를 기다리는 중...`;
      return { done: false, message: waitMsg };
    }

    // Both actions set -> resolve
    const result = this.resolveRound();
    return { done: true, message: result };
  }

  isReady() {
    return Object.values(this.actions).every((a) => a !== null);
  }

  resetActions() {
    this.actions[this.playerA.id] = null;
    this.actions[this.playerB.id] = null;
  }

  checkEnd() {
    if (this.playerA.hp <= 0 && this.playerB.hp <= 0) {
      this.isFinished = true;
      this.winnerId = null; // draw
      return true;
    }
    if (this.playerA.hp <= 0) {
      this.isFinished = true;
      this.winnerId = this.playerB.id;
      return true;
    }
    if (this.playerB.hp <= 0) {
      this.isFinished = true;
      this.winnerId = this.playerA.id;
      return true;
    }
    return false;
  }

  // ---- combat math ----
  isAttackHit(attacker, defender) {
    // 간단한 명중 계산 예시:
    // baseHit 80% + (attacker.agi - defender.agi)*0.5% (clamp)
    const base = 0.80;
    const diff = (attacker.agi - defender.agi) * 0.005;
    const hit = Math.max(0.10, Math.min(0.95, base + diff));
    return Math.random() < hit;
  }

  tryEvade(defender) {
    // 회피 확률: agi%
    const chance = Math.max(0.05, Math.min(0.60, defender.agi / 100)); // 너무 사기 안 되게 상한
    return Math.random() < chance;
  }

  tryDefend(defender) {
    // 방어 성공 확률: def% (상한)
    const chance = Math.max(0.05, Math.min(0.60, defender.def / 100));
    return Math.random() < chance;
  }

  calcDamage(attacker, defender, defenderAction) {
    let dmg = attacker.atk;

    // 크리
    if (Math.random() < (attacker.crit ?? 0)) {
      dmg = Math.floor(dmg * 1.5);
      dmg = Math.max(0, dmg);
      return { dmg, crit: true };
    }

    // 방어(성공 시) 피해 감소
    if (defenderAction === ACTION.DEFEND) {
      const ok = this.tryDefend(defender);
      if (ok) {
        dmg = Math.max(0, dmg - defender.def);
        return { dmg, defended: true };
      }
      return { dmg, defended: false };
    }

    return { dmg, defended: undefined };
  }

  // ---- resolution ----
  resolveRound() {
    const [first, second] = this.turnOrder;

    const aAction = this.actions[this.playerA.id];
    const bAction = this.actions[this.playerB.id];

    let log = [];
    log.push(`🏁 라운드 ${this.round}`);
    log.push(`- ${this.playerA.name}: ${this.actionKo(aAction)} / ${this.playerB.name}: ${this.actionKo(bAction)}`);
    log.push('');

    // speed order processing
    log.push(...this.processSingleAction(first, second));

    if (!this.checkEnd()) {
      log.push(...this.processSingleAction(second, first));
    }

    if (this.checkEnd()) {
      log.push('');
      log.push(this.finishMessage());
      return log.join('\n');
    }

    // next round
    this.round += 1;
    this.resetActions();

    log.push('');
    log.push(this.statusLine());
    log.push('다음 라운드 행동을 선택해줘. (공격/방어/회피)');
    return log.join('\n');
  }

  actionKo(action) {
    if (action === ACTION.ATTACK) return '공격';
    if (action === ACTION.DEFEND) return '방어';
    if (action === ACTION.EVADE) return '회피';
    return '미정';
  }

  processSingleAction(attacker, defender) {
    const attackerAction = this.actions[attacker.id];
    const defenderAction = this.actions[defender.id];

    let lines = [];

    // 공격이 아닌 행동은 "선언"만 하고 효과는 상대 공격에 반영되는 형태
    if (attackerAction === ACTION.DEFEND) {
      lines.push(`🛡️ ${attacker.name} 방어 준비!`);
      return lines;
    }
    if (attackerAction === ACTION.EVADE) {
      lines.push(`💨 ${attacker.name} 회피 준비!`);
      return lines;
    }

    // 공격 처리
    if (attackerAction === ACTION.ATTACK) {
      // 상대가 회피면 회피 우선
      if (defenderAction === ACTION.EVADE) {
        const evaded = this.tryEvade(defender);
        if (evaded) {
          lines.push(`💨 ${defender.name} 회피 성공! (${attacker.name}의 공격 무효)`);
          return lines;
        }
        lines.push(`💥 ${defender.name} 회피 실패!`);
      }

      // 명중 판정
      if (!this.isAttackHit(attacker, defender)) {
        lines.push(`❌ ${attacker.name} 공격 실패!`);
        return lines;
      }

      // 데미지 계산(방어 고려)
      const { dmg, crit, defended } = this.calcDamage(attacker, defender, defenderAction);

      defender.hp = Math.max(0, defender.hp - dmg);

      let tail = '';
      if (crit) tail += ' (치명타!)';
      if (defenderAction === ACTION.DEFEND) {
        if (defended === true) tail += ' (방어 성공)';
        if (defended === false) tail += ' (방어 실패)';
      }

      lines.push(`⚔️ ${attacker.name} 공격! ${defender.name}에게 ${dmg} 데미지${tail}`);
      return lines;
    }

    // fallback
    lines.push(`${attacker.name}는 아무것도 하지 않았다...`);
    return lines;
  }

  statusLine() {
    const a = this.playerA;
    const b = this.playerB;
    return `❤️ ${a.name} ${a.hp}/${a.maxHp} ${hpBar(a.hp, a.maxHp)}\n❤️ ${b.name} ${b.hp}/${b.maxHp} ${hpBar(b.hp, b.maxHp)}`;
  }

  finishMessage() {
    const a = this.playerA;
    const b = this.playerB;

    const status = this.statusLine();
    if (this.winnerId === null && a.hp <= 0 && b.hp <= 0) {
      return `🤝 무승부!\n\n${status}`;
    }
    const winner = this.getPlayer(this.winnerId);
    const loser = this.getOpponent(this.winnerId);
    return `🏆 ${winner.name} 승리! (${loser.name} 패배)\n\n${status}`;
  }
}

// -----------------------------
// 4) Battle Manager (multiple battles)
// -----------------------------
class BattleManager {
  constructor() {
    this.battlesById = new Map(); // battleId -> Battle
    this.battleIdByPlayer = new Map(); // acct -> battleId (참가 중인 전투 찾기)
  }

  findBattleForPlayer(acct) {
    const battleId = this.battleIdByPlayer.get(acct);
    if (!battleId) return null;
    return this.battlesById.get(battleId) ?? null;
  }

  startBattle(charA, charB) {
    const battleId = makeBattleId(charA.id, charB.id);

    if (this.battlesById.has(battleId)) {
      return { ok: false, battleId, message: `이미 진행 중인 전투야.` };
    }
    if (this.battleIdByPlayer.has(charA.id) || this.battleIdByPlayer.has(charB.id)) {
      return { ok: false, battleId, message: `둘 중 누군가 이미 다른 전투 중이야.` };
    }

    const battle = new Battle(charA, charB);
    this.battlesById.set(battleId, battle);
    this.battleIdByPlayer.set(charA.id, battleId);
    this.battleIdByPlayer.set(charB.id, battleId);

    const [first] = battle.turnOrder;
    const intro =
      `⚔️ 전투 시작!\n` +
      `${battle.playerA.name} vs ${battle.playerB.name}\n` +
      `선공(판정 순서): ${first.name}\n\n` +
      `${battle.statusLine()}\n\n` +
      `둘 다 행동을 선택해줘. (공격/방어/회피)`;

    return { ok: true, battleId, message: intro };
  }

  submitAction(playerAcct, action) {
    const battle = this.findBattleForPlayer(playerAcct);
    if (!battle) {
      return { ok: false, message: `너는 지금 전투 중이 아니야. "@봇 전투 @A @B"로 시작해줘.` };
    }

    const res = battle.setAction(playerAcct, action);

    // 라운드 판정까지 끝났고 전투 종료면 정리
    if (battle.isFinished) {
      const bid = this.battleIdByPlayer.get(playerAcct);
      // 안전하게 두명 모두 정리
      this.battleIdByPlayer.delete(battle.playerA.id);
      this.battleIdByPlayer.delete(battle.playerB.id);
      if (bid) this.battlesById.delete(bid);
    }

    return { ok: true, message: res.message };
  }
}

const battleManager = new BattleManager();

// -----------------------------
// 5) Command parsing + Mastodon event handler stub
// -----------------------------

/**
 * Extract mentioned user acct list from a status.
 * Depending on library, status.mentions may be { acct, id, username }.
 */
function extractMentionedAccts(status) {
  const mentions = status?.mentions ?? [];
  const accts = mentions
    .map((m) => m?.acct)
    .filter(Boolean)
    .map((s) => String(s).trim());

  // 어떤 라이브러리는 acct에 "@user@server" 형태로 올 수도 있어서 앞 @ 제거
  return accts.map((a) => a.startsWith('@') ? a.slice(1) : a);
}

/**
 * Parse command from status text.
 * Returns: { type: 'start'|'action'|'unknown', ... }
 */
function parseCommand(statusText) {
  const text = normalizeText(statusText);
  if (!text) return { type: 'unknown' };

  // 아주 단순 파싱:
  // - "전투" 포함이면 start
  // - "공격/방어/회피" 단어 있으면 action
  // (정교하게 하려면 regex 더 보강하면 됨)
  if (text.includes('전투')) return { type: 'start' };

  for (const [ko, en] of ACTION_KO_TO_ENUM.entries()) {
    if (text.includes(ko)) return { type: 'action', action: en };
  }

  return { type: 'unknown' };
}

/**
 * Get character data from store using acct.
 * Also attach current display name from status account if possible.
 */
function buildCharacterFromAcct(acct, displayNameMaybe) {
  const base = characterStore.get(acct);
  if (!base) return null;

  const c = structuredCloneSafe(base);
  c.name = pickDisplayName({ display_name: displayNameMaybe }, base.baseName);
  c.hp = c.maxHp; // battle uses current hp
  return c;
}

/**
 * Main handler: call this when a status mentions your bot.
 * It returns reply text (string) or null if no reply.
 */
function handleIncomingStatus(status) {
  // actor
  const actorAcctRaw = status?.account?.acct;
  const actorAcct = actorAcctRaw?.startsWith('@') ? actorAcctRaw.slice(1) : actorAcctRaw;
  const actorName = status?.account?.display_name;

  const content = status?.content ?? status?.text ?? '';
  const cmd = parseCommand(content);

  if (!actorAcct) return null;

  // start battle: expects exactly 2 user mentions excluding bot mention
  if (cmd.type === 'start') {
    const mentioned = extractMentionedAccts(status)
      .filter((a) => a && a !== BOT_ACCT); // 혹시 mentions에 봇도 들어오면 제거

    // 보통 호출자는 mentions에 포함 안 되니까,
    // 사용자가 "@봇 전투 @A @B" 형태면 mentioned에 A,B가 들어올 거야.
    if (mentioned.length < 2) {
      return `전투 시작은 "@봇 전투 @상대1 @상대2" 처럼 두 명을 멘션해줘.`;
    }

    const acctA = mentioned[0];
    const acctB = mentioned[1];

    if (acctA === acctB) {
      return `자기 자신과는 싸울 수 없어 ㅋㅋ`;
    }

    // 캐릭터 존재 확인 (30명 제한)
    const charA = buildCharacterFromAcct(acctA, null);
    const charB = buildCharacterFromAcct(acctB, null);

    if (!charA || !charB) {
      const missing = [!charA ? acctA : null, !charB ? acctB : null].filter(Boolean);
      return `등록되지 않은 참가자가 있어: ${missing.join(', ')}\n(미리 등록된 30명만 가능)`;
    }

    // 전투 참가자 닉네임은 "현재 상태에서 보이는 display_name"이 제일 좋은데
    // start 메시지에는 mentioned 계정의 display_name이 안 들어올 수 있어서 baseName으로 일단 표시.
    // (원하면 start 시점에 account lookup 해서 최신 display_name을 채우는 단계 추가 가능)
    const res = battleManager.startBattle(charA, charB);
    return res.message;
  }

  // action: actor must be in a battle
  if (cmd.type === 'action') {
    // actor가 등록된 캐릭터인지 확인(등록 안 된 사람이 명령하면 컷)
    if (!characterStore.has(actorAcct)) {
      return `너는 전투 참가 등록이 안 되어있어. (미리 등록된 사람만 가능)`;
    }

    // 캐릭터 표시명은 “행동 입력한 사람”은 최신 display_name으로 갱신해줄 수 있음(선택)
    // 여기서는 전투 중 이름을 굳이 바꾸진 않지만, 원하면 battle 객체에서 player.name 업데이트 가능함.
    const res = battleManager.submitAction(actorAcct, cmd.action);
    return res.message;
  }

  return null;
}
