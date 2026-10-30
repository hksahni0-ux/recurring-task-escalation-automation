/**
 * Loads every src/*.js file into one shared V8 context, mimicking how Apps Script
 * concatenates project files into a single global scope.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src');

function loadGas(globals = {}) {
  const ctx = vm.createContext({ console, Date, ...globals });
  fs.readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

module.exports = { loadGas };
