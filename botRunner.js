const Mastodon = require('mastodon-api');
const { handleIncomingStatus } = require('./index');

// 🔥 여기 수정
const BOT_ACCT = '@sawa_3@mastodon.social';

const M = new Mastodon({
  access_token: 'vfLlofBqn4YNxxhwf93NNKq-prqc4R0QT8k6BGujhfg',
  api_url: 'https://@sawa_3@mastodon.social/api/v1/',
});

// 유저 스트림 (멘션 포함)
const stream = M.stream('streaming/user');

stream.on('message', async (msg) => {
  if (msg.event !== 'update') return;

  const status = msg.data;

  // 자기 자신 무시
  if (status.account.acct === BOT_ACCT) return;

  const reply = handleIncomingStatus(status);
  if (!reply) return;

  try {
    await M.post('statuses', {
      status: `@${status.account.acct} ${reply}`,
      in_reply_to_id: status.id,
      visibility: status.visibility,
    });

    console.log('답장 완료');
  } catch (err) {
    console.error(err);
  }
});

console.log('봇 실행 중...');
