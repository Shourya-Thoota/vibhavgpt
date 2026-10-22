import { pool } from "../db/client.js";

// Runs `work` in one transaction on a dedicated client. Every ledger change
// goes through here so a balance check and its debit cannot interleave.
export async function transaction(work, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export { pool };
