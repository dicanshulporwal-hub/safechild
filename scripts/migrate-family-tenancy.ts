#!/usr/bin/env ts-node

/**
 * SafeBrowse Stage 11 Step 3C: Explicit Legacy Family Tenancy Migration CLI
 */

import { runMigration, MigrationReport } from '../packages/backend/src/utils/tenancy-migration';

export { runMigration, MigrationReport };

if (require.main === module) {
  const args = process.argv.slice(2);
  const applyChanges = args.includes('--apply') || args.includes('--execute');

  console.log(`\n=== SafeBrowse Family Tenancy Migration (${applyChanges ? 'APPLY MODE' : 'DRY RUN'}) ===\n`);

  try {
    const report = runMigration(undefined, applyChanges);

    console.log('Migration Counts Summary:');
    console.log(`  - Migrated:    ${report.counts.migrated}`);
    console.log(`  - Unchanged:   ${report.counts.unchanged}`);
    console.log(`  - Conflicted:  ${report.counts.conflicted}`);
    console.log(`  - Quarantined: ${report.counts.quarantined}`);

    if (report.details.length > 0) {
      console.log('\nDetails:');
      report.details.forEach((d) => console.log(`  ${d}`));
    }

    if (!applyChanges && (report.counts.migrated > 0 || report.counts.quarantined > 0)) {
      console.log('\n[INFO] This was a dry run. To apply mutations and backup, run:');
      console.log('       npx ts-node scripts/migrate-family-tenancy.ts --apply\n');
    } else {
      console.log('\n✅ Tenancy migration completed cleanly.\n');
    }
  } catch (err: any) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}
