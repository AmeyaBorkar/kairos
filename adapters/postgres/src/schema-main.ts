import { schemaSql } from "./schema.js";

/**
 * Print the DDL.
 *
 * `npx kairos-casualty-schema [table] | psql "$DATABASE_URL"`, so a deployment that keeps schema
 * changes out of the application's hands does not have to read TypeScript to find out what the
 * application expects of its database.
 */
process.stdout.write(schemaSql(process.argv[2] ?? "kairos_casualty"));
