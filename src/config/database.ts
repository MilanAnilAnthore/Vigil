import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString,
  min: 5,
  max: 20,
  idleTimeoutMillis: 30000,
  query_timeout: 3000,
});

pool.on("error", (err) => {
  console.error("Unexpected idle client error", err);
});

export async function verifyConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}
