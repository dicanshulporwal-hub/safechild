import EmbeddedPostgres from 'embedded-postgres';
import path from 'path';

async function main() {
  const dataDir = path.resolve(__dirname, '../.pgdata');
  const pg = new EmbeddedPostgres({
    port: 5432,
    databaseDir: dataDir,
    user: 'safebrowse',
    password: 'safebrowse_dev_secret',
    persistent: true,
  });

  console.log('Initializing embedded PostgreSQL on port 5432...');
  await pg.initialise();
  console.log('Starting PostgreSQL server...');
  await pg.start();
  console.log('PostgreSQL server started successfully on port 5432.');

  try {
    await pg.createDatabase('safebrowse_test');
    console.log("Database 'safebrowse_test' ready.");
  } catch {
    console.log("Database 'safebrowse_test' already exists or ready.");
  }

  try {
    await pg.createDatabase('safebrowse_dev');
    console.log("Database 'safebrowse_dev' ready.");
  } catch {
    console.log("Database 'safebrowse_dev' already exists or ready.");
  }

  console.log('PostgreSQL service is live and listening on localhost:5432.');
  
  // Keep process alive as daemon
  setInterval(() => {}, 10000);
}

main().catch((err) => {
  console.error('Failed to start embedded PostgreSQL:', err);
  process.exit(1);
});
