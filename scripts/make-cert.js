// Creates a private certificate authority (CA) plus an HTTPS certificate for this PC's
// LAN IP addresses. iPhone Safari only allows microphone access on HTTPS, so the phone
// must trust the CA once (see README).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.resolve('certs');
fs.mkdirSync(dir, { recursive: true });
const f = (name) => path.join(dir, name);
// On Windows, openssl usually comes with Git for Windows but is not on PATH.
function gitOpenssl() {
  try {
    // e.g. D:/C/Git/mingw64/libexec/git-core -> D:/C/Git/mingw64/bin/openssl.exe
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    return path.resolve(execPath, '..', '..', 'bin', 'openssl.exe');
  } catch {
    return null;
  }
}
const OPENSSL = [
  gitOpenssl(),
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
].find((p) => p && fs.existsSync(p)) || 'openssl';
const openssl = (...args) => execFileSync(OPENSSL, args, { stdio: 'pipe' });

const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);

if (!fs.existsSync(f('ca.crt'))) {
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
    '-keyout', f('ca.key'), '-out', f('ca.crt'),
    '-subj', '/CN=MISHU Translator Local CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  console.log('Created new CA: certs/ca.crt');
} else {
  console.log('Reusing existing CA: certs/ca.crt');
}

const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
fs.writeFileSync(f('server.ext'),
  `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);

openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('server.key'),
  '-out', f('server.csr'), '-subj', '/CN=MISHU Translator');
// iOS rejects server certificates valid for more than 825 days.
openssl('x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'),
  '-CAcreateserial', '-out', f('server.crt'), '-days', '800', '-extfile', f('server.ext'));

console.log(`Server certificate created for: ${san}`);
console.log('If your PC IP address changes, run "npm run cert" again (the phone keeps trusting the same CA).');
