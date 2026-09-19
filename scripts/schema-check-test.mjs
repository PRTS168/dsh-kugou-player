/**
 * Unit tests for the schema checker.
 *
 * A guard that has never been shown to fail is not a guard. The negative cases
 * below include the exact definition that broke a live turn, so the checker is
 * proven to reject it before it is trusted to protect the real tools.
 */
import { validateSchema, isSchemaValid, findDslContamination } from './lib/schema-check.mjs';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

console.log('\n=== schema-check unit tests ===\n');

// ---- positive cases: real, valid shapes -----------------------------------
check(
  '接受合法的无参数 schema',
  isSchemaValid({ type: 'object', properties: {}, required: [] }),
);

check(
  '接受合法的带参 schema',
  isSchemaValid({
    type: 'object',
    properties: {
      query: { type: 'string', description: 'x' },
      limit: { type: 'integer' },
      loop: { type: 'boolean' },
      quality: { type: 'string', enum: ['auto', '320'] },
    },
    required: ['query'],
  }),
);

check('接受嵌套 items 数组', isSchemaValid({ type: 'array', items: { type: 'string' } }));
check('接受 oneOf', isSchemaValid({ oneOf: [{ type: 'number' }, { type: 'boolean' }] }));
check('接受 additionalProperties: false', isSchemaValid({ type: 'object', additionalProperties: false }));
check('接受 additionalProperties 为 schema', isSchemaValid({ type: 'object', additionalProperties: { type: 'string' } }));
check('接受字符串数组 type', isSchemaValid({ type: ['string', 'null'] }));

// ---- negative cases: the real failure, then its neighbours ----------------
const THE_BUG = {
  type: 'object',
  properties: {
    action: { type: 'string', required: true, enum: ['pause', 'resume'] },
  },
  required: ['action'],
};
const bugProblems = validateSchema(THE_BUG);
check(
  '拒绝 DSL 式 required: true（就是导致安全模式的那个）',
  bugProblems.length > 0,
  bugProblems[0] ?? 'CHECKER FAILED TO CATCH',
);
check('错误信息指明具体位置', /properties\.action/.test(bugProblems.join(' ')), bugProblems.join(' | '));

check(
  '拒绝 required: false',
  validateSchema({ type: 'object', properties: { a: { type: 'string', required: false } } }).length > 0,
);
check(
  '拒绝顶层 required 为字符串',
  validateSchema({ type: 'object', properties: { a: { type: 'string' } }, required: 'a' }).length > 0,
);
check('拒绝 required 里出现非字符串', validateSchema({ required: [1] }).length > 0);
check(
  '拒绝 required 指向不存在的属性',
  validateSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }).length > 0,
);
check('拒绝非法 type', validateSchema({ type: 'strng' }).length > 0);
check('拒绝 properties 为数组', validateSchema({ type: 'object', properties: [] }).length > 0);
check('拒绝 enum 非数组', validateSchema({ type: 'string', enum: 'a' }).length > 0);
check('拒绝 oneOf 非数组', validateSchema({ oneOf: { type: 'string' } }).length > 0);
check('拒绝 schema 节点为 null', validateSchema(null).length > 0);
check('拒绝 schema 节点为数组', validateSchema([]).length > 0);
check(
  '能发现深层嵌套里的 DSL 污染',
  validateSchema({
    type: 'object',
    properties: { outer: { type: 'object', properties: { inner: { type: 'string', required: true } } } },
  }).length > 0,
);

// ---- textual backstop -----------------------------------------------------
check('文本兜底能识别 DSL 污染', findDslContamination(THE_BUG) === true);
check('文本兜底不误报正常 schema', findDslContamination({ properties: { a: { type: 'string' } }, required: ['a'] }) === false);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`);
  process.exitCode = 1;
}
