// scripts/hash-admin-password.js
// Genera el valor de ADMIN_PASS_HASH. La contraseña se lee de stdin (no de argumentos)
// para que no quede en el historial de la terminal.
//   npm run hash-admin-password
//   (escribe la contraseña y pulsa Enter; en terminal interactiva no se muestra)

const { hashPassword } = require('../security/admin-auth');

function readPassword() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (c) => { data += c; });
      stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    process.stderr.write('Contraseña del panel (mín. 12 caracteres): ');
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let pw = '';
    stdin.on('data', (ch) => {
      if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); process.stderr.write('\n'); resolve(pw); }
      else if (ch === '\u0003') { process.exit(130); }
      else if (ch === '\u007f' || ch === '\b') { pw = pw.slice(0, -1); }
      else { pw += ch; }
    });
  });
}

readPassword().then((pw) => {
  if (pw.length < 12) {
    console.error('La contraseña debe tener al menos 12 caracteres.');
    process.exit(1);
  }
  // Solo se imprime el hash (no reversible), nunca la contraseña.
  console.log(hashPassword(pw));
});
