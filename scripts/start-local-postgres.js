const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const rootDir = path.resolve(__dirname, '..');
  const binDir = path.resolve(rootDir, 'node_modules/@embedded-postgres/windows-x64/native/bin');
  const initdbPath = path.resolve(binDir, 'initdb.exe');
  const postgresPath = path.resolve(binDir, 'postgres.exe');
  const dataDir = path.resolve(rootDir, '.pgdata');
  const pwFile = path.resolve(rootDir, '.pgpass_temp');

  if (!fs.existsSync(dataDir) || !fs.existsSync(path.resolve(dataDir, 'PG_VERSION'))) {
    console.log('Initializing PostgreSQL cluster with UTF8 encoding...');
    fs.writeFileSync(pwFile, 'safebrowse_password\n');
    
    const initRes = spawnSync(
      initdbPath,
      [
        '-D', dataDir,
        '-E', 'UTF8',
        '--no-locale',
        '-U', 'safebrowse',
        `--pwfile=${pwFile}`,
        '-A', 'scram-sha-256',
        '--auth-host=scram-sha-256',
        '--auth-local=scram-sha-256',
      ],
      { stdio: 'inherit' }
    );

    try { fs.unlinkSync(pwFile); } catch {}
    
    if (initRes.status !== 0) {
      console.error('initdb failed with exit code', initRes.status);
      process.exit(1);
    }
  }

  console.log('Starting PostgreSQL server on port 5432...');
  const proc = spawn(postgresPath, ['-D', dataDir, '-p', '5432'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  proc.on('error', (err) => {
    console.error('PostgreSQL process error:', err);
  });

  // Wait for postgres to accept connections
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const client = new Client({
        host: 'localhost',
        port: 5432,
        user: 'safebrowse',
        password: 'safebrowse_password',
        database: 'postgres',
      });
      await client.connect();
      
      // Ensure databases exist
      try {
        await client.query('CREATE DATABASE safebrowse_test');
        console.log("Database 'safebrowse_test' created.");
      } catch {}

      try {
        await client.query('CREATE DATABASE safebrowse_dev');
        console.log("Database 'safebrowse_dev' created.");
      } catch {}

      await client.end();
      ready = true;
      break;
    } catch {}
  }

  if (!ready) {
    console.error('Timed out waiting for PostgreSQL to start.');
    process.exit(1);
  }

  console.log('PostgreSQL service is live on port 5432 with UTF8 encoding.');
  
  process.on('SIGINT', () => proc.kill('SIGINT'));
  process.on('SIGTERM', () => proc.kill('SIGTERM'));

  setInterval(() => {}, 10000);
}

main().catch((err) => {
  console.error('Fatal launcher error:', err);
  process.exit(1);
});
