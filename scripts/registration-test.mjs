/**
 * Registration test: mount the plugin against a stub cordis context and assert
 * that the five tools register with schemas a provider will actually accept.
 *
 * The strict schema walk exists because a real failure shipped past the first
 * version of this test: `music_control` carried a DSL-style `required: true`
 * inside a property, which is meaningless in raw JSON Schema and made the
 * provider reject the entire request — failing the turn, not the tool call.
 * Checking only that `required` is an array at the top level was not enough, so
 * every subschema is validated recursively.
 *
 * Loads no audio device and plays nothing.
 */
import { apply, name, inject } from '../lib/index.js';
import { validateSchema, findDslContamination } from './lib/schema-check.mjs';

const registered = [];
const systemPromptSections = [];
let effectDisposer = null;

const ctx = {
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  },
  systemPrompt: {
    section(section) {
      systemPromptSections.push(section);
    },
  },
  effect(fn) {
    effectDisposer = fn();
  },
  get(service) {
    if (service === 'systemPrompt') return ctx.systemPrompt;
    if (service === 'logger') return { warn: () => {}, info: () => {} };
    return undefined;
  },
};

apply(ctx, { volume: 50, quality: 'auto', searchLimit: 8, timeoutMs: 20000, maxTrackMinutes: 12, sink: 'auto' });

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// Strict JSON Schema walk — mirrors what a provider rejects outright.
// Shared with (and unit-tested by) scripts/schema-check-test.mjs so the two
// cannot drift apart.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
console.log(`\n=== dsh-music-player registration test ===\n`);
check('插件导出 name/inject/apply', name === 'dsh-music-player' && Array.isArray(inject) && typeof apply === 'function');

const expected = ['play_music', 'music_control', 'music_status', 'search_music', 'music_login'];
const names = registered.map((d) => d.name).sort();
check('注册了五个工具', registered.length === 5, names.join(', '));
for (const want of expected) check(`存在 ${want}`, names.includes(want));

for (const def of registered) {
  const params = def.parameters;
  check(`${def.name} parameters 是对象`, Boolean(params) && params.type === 'object' && typeof params.properties === 'object');

  const problems = [];
  validateSchema(params, `${def.name}.parameters`, problems);
  check(`${def.name} 参数 schema 严格合法`, problems.length === 0, problems.join(' | '));

  const outProblems = [];
  validateSchema(def.output?.schema, `${def.name}.output.schema`, outProblems);
  check(`${def.name} 输出 schema 严格合法`, outProblems.length === 0, outProblems.join(' | '));

  check(`${def.name} 有 description`, typeof def.description === 'string' && def.description.length > 20);
  check(`${def.name} 有 output.render`, typeof def.output?.render === 'function');
  check(`${def.name} execute 是函数`, typeof def.execute === 'function');
}

// The exact regression, asserted directly so it can never come back unnoticed.
const controlDef = registered.find((d) => d.name === 'music_control');
check(
  'music_control 属性内没有 DSL 式 required',
  findDslContamination(controlDef?.parameters) === false,
);
check(
  'music_control 用强类型 volume/loop 而非多态 value',
  Boolean(controlDef?.parameters?.properties?.volume) &&
    Boolean(controlDef?.parameters?.properties?.loop) &&
    !('value' in (controlDef?.parameters?.properties ?? {})),
);

check('写入 systemPrompt 引导段', systemPromptSections.length === 1, systemPromptSections[0]?.name ?? '(none)');
check('引导段提到 play_music', /play_music/.test(systemPromptSections[0]?.text ?? ''));

// Behaviour on an idle player: a control call must answer, not throw.
const idlePause = await controlDef.execute({ action: 'pause' }, {});
check('空闲时 pause 返回失败而非抛错', idlePause.ok === false && typeof idlePause.message === 'string', idlePause.message);

const statusDef = registered.find((d) => d.name === 'music_status');
const statusResult = await statusDef.execute({}, {});
check('music_status 空闲可读', statusResult.state === 'idle', statusResult.message);

const loopOn = await controlDef.execute({ action: 'loop', loop: true }, {});
check('loop=true 生效', loopOn.loop === true, loopOn.message);
const loopOff = await controlDef.execute({ action: 'loop', loop: false }, {});
check('loop=false 生效', loopOff.loop === false, loopOff.message);
const loopMissing = await controlDef.execute({ action: 'loop' }, {});
check('缺 loop 参数被拒绝', loopMissing.ok === false, loopMissing.message);
const volMissing = await controlDef.execute({ action: 'volume' }, {});
check('缺 volume 参数被拒绝', volMissing.ok === false, volMissing.message);
const volOk = await controlDef.execute({ action: 'volume', volume: 33 }, {});
check('volume 生效', volOk.volume === 33, volOk.message);

const badAction = await controlDef.execute({ action: 'explode' }, {});
check('未知 action 被拒绝', badAction.ok === false, badAction.message);

const searchDef = registered.find((d) => d.name === 'search_music');
const emptyQuery = await searchDef.execute({ query: '   ' }, {});
check('空关键词被拒绝', emptyQuery.count === 0 && emptyQuery.message.includes('不能为空'), emptyQuery.message);

// ---- music_login -----------------------------------------------------------
// Every branch below must answer WITHOUT touching the network: a missing
// argument is a conversation mistake, not a reason to send an SMS. If these
// ever hang, the tool started calling the login service on bad input.
const loginDef = registered.find((d) => d.name === 'music_login');

const loginStatus = await loginDef.execute({ action: 'status' }, {});
check('music_login status 不联网可读', loginStatus.ok === true && typeof loginStatus.loggedIn === 'boolean', loginStatus.message);

const actionEnumNow = loginDef.parameters?.properties?.action?.enum ?? [];
check(
  '短信登录动作已从工具下线（无 send_code/submit_code）',
  !actionEnumNow.includes('send_code') && !actionEnumNow.includes('submit_code'),
  actionEnumNow.join(','),
);

const smsRejected = await loginDef.execute({ action: 'send_code', mobile: '13800000000', code: '1234' }, {});
check('短信动作调用被拒绝且不联网', smsRejected.ok === false, smsRejected.message);

const loginUnknown = await loginDef.execute({ action: 'teleport' }, {});
check('music_login 未知 action 被拒绝', loginUnknown.ok === false, loginUnknown.message);

// qr_poll before qr_start must answer locally: polling with no key would
// otherwise be a pointless network call.
const qrPollFirst = await loginDef.execute({ action: 'qr_poll' }, {});
check(
  'qr_poll 未生成二维码时拒绝且不联网',
  qrPollFirst.ok === false && /qr_start/.test(qrPollFirst.message),
  qrPollFirst.message,
);

const actionEnum = loginDef.parameters?.properties?.action?.enum ?? [];
check(
  'music_login 暴露扫码动作',
  actionEnum.includes('qr_start') && actionEnum.includes('qr_poll'),
  actionEnum.join(','),
);

check(
  'music_login 输出 schema 含 loggedIn',
  Boolean(loginDef.output?.schema?.properties?.loggedIn),
);

check('注册了 effect 清理', typeof effectDisposer === 'function');
if (typeof effectDisposer === 'function') {
  await effectDisposer();
  check('清理执行无异常', true);
}

// Other tools' parameter schemas, checked for the same DSL contamination.
const strayDsl = registered.filter((d) => findDslContamination(d.parameters)).map((d) => d.name);
check('没有任何工具混入 DSL 式 required', strayDsl.length === 0, strayDsl.join(', '));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`);
  process.exitCode = 1;
}
