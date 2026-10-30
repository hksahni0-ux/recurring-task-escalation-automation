const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    // Apps Script: every file shares one global scope, so cross-file names are not "undefined"
    // and top-level functions are entry points (menus, triggers, google.script.run).
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2019, sourceType: 'script', globals: { ...globals.es2015 } },
    rules: { 'no-undef': 'off', 'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }] },
  },
  {
    files: ['test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node, ...globals.jest } },
  },
];
