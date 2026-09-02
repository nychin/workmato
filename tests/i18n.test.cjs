const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// ── electron 桩：repository 在 load()/reset() 中调用 app.getLocale()/app.getPath() ──
let stubLocale = 'zh-CN';
const stubApp = {
  getPath: (name) => path.join(os.tmpdir(), `tomato-i18n-test-${name}`),
  getLocale: () => stubLocale,
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: stubApp };
  return originalLoad.apply(this, arguments);
};

const { zhCN } = require('../dist/shared/i18n/zh-CN.js');
const { enUS } = require('../dist/shared/i18n/en-US.js');
const { jaJP } = require('../dist/shared/i18n/ja-JP.js');
const { detectAppLanguage, setLocale, t } = require('../dist/shared/i18n/index.js');
const { normalizeSettings } = require('../dist/main/settings/repository.js');
const { SettingsRepository } = require('../dist/main/settings/repository.js');

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(text) {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]).sort().join(',');
}

test('en-US and ja-JP dictionaries cover exactly the zh-CN keys', () => {
  const zhKeys = Object.keys(zhCN).sort();
  assert.deepEqual(Object.keys(enUS).sort(), zhKeys, 'en-US keys must match zh-CN');
  assert.deepEqual(Object.keys(jaJP).sort(), zhKeys, 'ja-JP keys must match zh-CN');
});

test('placeholders are preserved across all languages', () => {
  for (const key of Object.keys(zhCN)) {
    const expected = placeholders(zhCN[key]);
    assert.equal(placeholders(enUS[key]), expected, `en-US placeholder mismatch on ${key}`);
    assert.equal(placeholders(jaJP[key]), expected, `ja-JP placeholder mismatch on ${key}`);
  }
});

test('t() interpolates params and falls back to zh-CN', () => {
  setLocale('en-US');
  assert.equal(t('status.error.integerRange', { min: 1, max: 99 }), 'Enter an integer between 1 and 99.');
  setLocale('ja-JP');
  assert.ok(t('taskflow.toast.edgesCut', { n: 3 }).includes('3'));
  setLocale('zh-CN');
  assert.equal(t('common.ok'), '确定');
});

test('detectAppLanguage maps system locales to supported languages', () => {
  assert.equal(detectAppLanguage('zh-CN'), 'zh-CN');
  assert.equal(detectAppLanguage('zh_TW'), 'zh-CN');
  assert.equal(detectAppLanguage('ja'), 'ja-JP');
  assert.equal(detectAppLanguage('ja-JP'), 'ja-JP');
  assert.equal(detectAppLanguage('en-US'), 'en-US');
  assert.equal(detectAppLanguage('fr-FR'), 'en-US');
  assert.equal(detectAppLanguage('ko'), 'en-US');
  assert.equal(detectAppLanguage(undefined), 'en-US');
});

test('normalizeSettings whitelists language values', () => {
  assert.equal(normalizeSettings({ language: 'ja-JP' }).language, 'ja-JP');
  assert.equal(normalizeSettings({ language: 'en-US' }).language, 'en-US');
  assert.equal(normalizeSettings({ language: 'zh-CN' }).language, 'zh-CN');
  assert.equal(normalizeSettings({ language: 'ko-KR' }).language, 'zh-CN');
  assert.equal(normalizeSettings({ language: 42 }).language, 'zh-CN');
  assert.equal(normalizeSettings({}).language, 'zh-CN');
  assert.equal(normalizeSettings(undefined).language, 'zh-CN');
});

test('first run and reset detect the system language', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tomato-i18n-repo-'));
  const repository = new SettingsRepository({ dataDirectory: directory });
  try {
    stubLocale = 'ja';
    const loaded = await repository.load();
    assert.equal(loaded.language, 'ja-JP');
    stubLocale = 'fr-FR';
    const reset = await repository.reset();
    assert.equal(reset.language, 'en-US');
    stubLocale = 'zh-CN';
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('existing settings keep their saved language across loads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tomato-i18n-keep-'));
  const repository = new SettingsRepository({ dataDirectory: directory });
  try {
    stubLocale = 'en-US';
    await repository.save({ language: 'ja-JP' });
    const loaded = await repository.load();
    assert.equal(loaded.language, 'ja-JP');
  } finally {
    stubLocale = 'zh-CN';
    await fs.rm(directory, { recursive: true, force: true });
  }
});
