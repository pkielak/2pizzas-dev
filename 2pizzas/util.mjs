import { execFile } from 'node:child_process';

export function execFileP(cmd, args, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}
