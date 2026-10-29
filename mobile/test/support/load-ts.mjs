import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');

// Execute the actual TypeScript source with injected platform modules. This
// keeps native Expo dependencies out of Node while exercising production logic.
export function loadTs(file, mocks = {}, cache = new Map()) {
  const filename = file instanceof URL ? fileURLToPath(file) : path.resolve(file);
  if (cache.has(filename)) return cache.get(filename).exports;
  const source = readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
  const module = { exports: {} };
  cache.set(filename, module);
  const dependency = name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) {
      const base = path.resolve(path.dirname(filename), name);
      const found = [base, `${base}.ts`, `${base}.native.ts`].find(candidate => existsSync(candidate));
      if (!found) throw new Error(`Test cannot resolve ${name} from ${filename}`);
      return loadTs(found, mocks, cache);
    }
    return require(name);
  };
  const evaluate = vm.runInThisContext(`(function(exports, require, module, __filename, __dirname) {\n${compiled.outputText}\n})`, { filename });
  evaluate(module.exports, dependency, module, filename, path.dirname(filename));
  return module.exports;
}
