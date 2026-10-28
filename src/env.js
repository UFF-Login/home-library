// Read a `.env` file without a dependency.
//
// Docker Compose reads `.env` itself, but `npm start` does not - so putting the
// login in `.env` worked in a container and silently did nothing when the app was
// run with node. This makes both paths read the same file.
//
// Rules, deliberately the subset Compose uses:
//   - blank lines and lines starting with # are ignored (so a commented-out
//     setting really is ignored - the mistake that made a password invisible);
//   - `KEY=value`, with optional surrounding single or double quotes;
//   - `export KEY=value` is accepted, because people paste it from a shell;
//   - an empty value counts as set-but-blank;
//   - a real environment variable always wins over the file, so `FOO=1 npm start`
//     still overrides `.env` the way every other tool behaves.
import { existsSync, readFileSync } from 'node:fs';

/** Parse `.env` text into a plain object. No side effects, so it is testable. */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);

    out[key] = value;
  }
  return out;
}

/**
 * Apply one file to process.env. Returns the keys that were actually applied -
 * a key already present in the real environment is reported as skipped, which is
 * what you need to answer "why is my .env being ignored?".
 */
export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return { path, applied: [], skipped: [] };
  let parsed;
  try {
    parsed = parseEnv(readFileSync(path, 'utf8'));
  } catch {
    return { path, applied: [], skipped: [] };
  }

  const applied = [];
  const skipped = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { path, applied, skipped };
}

/** Apply several files in order (later ones never override earlier ones). */
export function loadEnvFiles(paths, env = process.env) {
  return paths.map((path) => loadEnvFile(path, env));
}
