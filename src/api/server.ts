import { resolve } from "node:path";
import { openDatabase } from "../db/database.ts";
import { createApp, startBoundToLocalhost } from "./app.ts";

const dbPath = process.env.ARRAY_DB_PATH
  ? resolve(process.env.ARRAY_DB_PATH)
  : resolve("data", "array.db");

const db = openDatabase(dbPath);
const server = createApp(db);

startBoundToLocalhost(server).then(({ port, host }) => {
  const line = JSON.stringify({ host, port, db: dbPath, pid: process.pid });
  console.log(line);
});

function shutdown(signal: string): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  void signal;
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
