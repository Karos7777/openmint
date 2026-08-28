export const MIGRATIONS: string[] = [
  `CREATE TABLE attempts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     kind TEXT NOT NULL,
     message TEXT NOT NULL,
     latency_ms INTEGER,
     tx_hash TEXT
   )`,
  `CREATE INDEX attempts_ts ON attempts (ts DESC)`,
];

export function runMigrations(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const applied = storage.kv.get<number>("schema_version") ?? 0;
    for (let i = applied; i < MIGRATIONS.length; i++) {
      storage.sql.exec(MIGRATIONS[i]);
      storage.kv.put("schema_version", i + 1);
    }
  });
}
