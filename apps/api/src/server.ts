import "dotenv/config";
import { buildApp } from "./app.js";
import { initializeMySqlPersistence } from "./persistence/mysql-persistence.js";
import { store } from "./store/memory-store.js";

const dataDriver = process.env.DATA_DRIVER ?? "memory";
let databaseName: string | undefined;
if (dataDriver === "mysql") {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATA_DRIVER=mysql 时必须配置 DATABASE_URL");
  ({ database: databaseName } = await initializeMySqlPersistence(store, databaseUrl));
}

const app = await buildApp();
const port = Number(process.env.API_PORT ?? 3300);
const host = process.env.API_HOST ?? "127.0.0.1";

try {
  await app.listen({ port, host });
  if (databaseName) app.log.info({ databaseName }, "MySQL persistence ready");
} catch (error) {
  app.log.error(error);
  await store.closePersistence();
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await store.closePersistence();
    process.exit(0);
  });
}
