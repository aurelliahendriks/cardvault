/**
 * Account management from the command line.
 *
 * This exists because of a bootstrap problem: migration 013 creates the owner account with a
 * deliberately unusable password hash, so there is no way to log in and therefore no way to
 * use the web UI to create the first real password. The alternative — shipping a default
 * password — is the same default password a year later, on a machine now reachable from the
 * internet.
 *
 * Passwords are read from a prompt with echo off, never from an argument. A password in
 * `--password hunter2` is in your shell history, in `ps` output for anyone on the machine, and
 * in the Docker logs if you ran it through compose.
 *
 *   npm run user                              # list accounts
 *   npm run user -- --add felix               # create, prompting for the password
 *   npm run user -- --password felix          # change a password
 *   npm run user -- --rename owner ibi        # rename the bootstrap owner to something human
 *   npm run user -- --disable felix           # revoke access, keep the collection
 *   npm run user -- --enable felix
 *
 * In Docker, the dev override bind-mounts `src` but NOT `package.json`, so a newly added npm
 * script does not exist inside a container built before it. Call the file directly and it works
 * either way:
 *
 *   docker compose exec api npx tsx src/cli/user.ts --add felix
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { createUser, findUser, listUsers, setActive, setPassword, MIN_PASSWORD } from '../auth.js';
import { one, pool, q } from '../db.js';

/** Read a line with echo suppressed, so the password is not left on screen or in scrollback. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const anyRl = rl as any;
    // Overriding the output write is the documented-enough trick for hidden input in Node
    // without a dependency: readline still receives the keystrokes, the terminal shows nothing.
    anyRl._writeToOutput = (chunk: string) => {
      if (chunk.includes(prompt)) stdout.write(prompt);
    };
    rl.question(prompt, (answer) => { rl.close(); stdout.write('\n'); resolve(answer); });
  });
}

async function askPasswordTwice(): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await askHidden('password: ');
    if (a.length < MIN_PASSWORD) {
      console.log(`  too short — at least ${MIN_PASSWORD} characters`);
      continue;
    }
    const b = await askHidden('again:    ');
    if (a !== b) { console.log('  they did not match'); continue; }
    return a;
  }
  throw new Error('gave up after three tries');
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? '') : null;
};

try {
  const add = flag('--add');
  const pass = flag('--password');
  const disable = flag('--disable');
  const enable = flag('--enable');
  const renameFrom = flag('--rename');

  if (add) {
    const password = await askPasswordTwice();
    const display = flag('--name') ?? undefined;
    const u = await createUser({ username: add, password, displayName: display });
    console.log(`created ${u.username}`);
  } else if (pass) {
    const u = await findUser(pass);
    if (!u) throw new Error(`no account called "${pass}"`);
    const password = await askPasswordTwice();
    await setPassword(u.id, password);
    console.log(`password set for ${u.username} — any signed-in devices were logged out`);
  } else if (disable || enable) {
    const name = (disable ?? enable)!;
    const u = await findUser(name);
    if (!u) throw new Error(`no account called "${name}"`);
    if (u.role === 'owner' && disable) throw new Error('the owner account cannot be disabled');
    await setActive(u.id, Boolean(enable));
    console.log(`${u.username} is now ${enable ? 'active' : 'disabled'}`);
  } else if (renameFrom) {
    const to = args[args.indexOf('--rename') + 2];
    if (!to) throw new Error('usage: --rename <old> <new>');
    const u = await findUser(renameFrom);
    if (!u) throw new Error(`no account called "${renameFrom}"`);
    if (await findUser(to)) throw new Error(`"${to}" is taken`);
    if (!/^[a-z0-9._-]{2,32}$/i.test(to)) throw new Error('2-32 chars, letters/numbers/dot/dash/underscore');
    await q(`UPDATE users SET username = $2, display_name = COALESCE(display_name, $2) WHERE id = $1`,
      [u.id, to]);
    console.log(`${u.username} is now ${to}`);
  } else {
    const rows = await listUsers();
    if (!rows.length) { console.log('no accounts yet'); }
    const unset = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE pass_algo = 'unset'`);
    console.log('');
    for (const u of rows) {
      const bits = [
        u.username.padEnd(16),
        (u.role === 'owner' ? 'owner ' : 'member'),
        u.active ? 'active  ' : 'disabled',
        `${String(u.lines).padStart(5)} lines`,
        u.last_login_at ? `last in ${new Date(u.last_login_at).toISOString().slice(0, 10)}` : 'never signed in',
      ];
      console.log('  ' + bits.join('  '));
    }
    console.log('');
    if ((unset?.n ?? 0) > 0) {
      // Printed as the direct invocation rather than the npm alias: inside a container built
      // before the script existed, `npm run user` reports "Missing script" and the advice is
      // worse than none.
      const me = 'npx tsx src/cli/user.ts';
      console.log('  One or more accounts have no password yet and cannot sign in.');
      console.log(`  Rename it first if you like:  ${me} --rename owner <yourname>`);
      console.log(`  Then set a password:          ${me} --password <yourname>`);
      console.log('');
    }
  }
} catch (e: any) {
  console.error(`\n  ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
