import { existsSync, readFileSync } from 'fs';
import { Config } from './models';

/** Loads etc/config.json, with DATABASE_URL (environment or .env) overriding its database. */
export function loadConfig(path = process.env.JSCRAWL_CONFIG ?? 'etc/config.json'): Config {
  // Node does not overwrite variables that are already set, so the shell wins.
  if (existsSync('.env')) process.loadEnvFile();
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config;
  const url = process.env.DATABASE_URL;
  if (url) {
    if (!/^postgres(ql)?:\/\//i.test(url)) {
      throw new Error('DATABASE_URL must be a postgres:// or postgresql:// url');
    }
    config.database = { ...config.database, dialect: 'postgres', connection: url };
  }
  return config;
}
