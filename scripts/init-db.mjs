import pg from "pg";
const c = new pg.Client({
  host: "127.0.0.1",
  port: 55432,
  user: "loginlab",
  password: process.env.DATABASE_PASSWORD || "loginlab_dev",
  database: "postgres",
});
try {
  await c.connect();
  const r = await c.query("SELECT 1 FROM pg_database WHERE datname=$1", [
    "loginlab",
  ]);
  if (!r.rowCount) await c.query("CREATE DATABASE loginlab");
  console.log("Project PostgreSQL database ready");
} finally {
  await c.end();
}
