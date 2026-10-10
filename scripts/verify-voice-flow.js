import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { app } from "../src/server.js";
import { pool } from "../src/db/client.js";
// A fresh password per run for the disposable local test account.
const password = `Verify-${randomBytes(18).toString("base64url")}9`;

const port = 3107, origin = `http://127.0.0.1:${port}`;
const email = `voice-test-${randomUUID()}@example.invalid`;
let userId, server;
async function cleanup() { if (!userId) return; await pool.query("DELETE FROM usage_events WHERE user_id=$1",[userId]); await pool.query("DELETE FROM subscriptions WHERE user_id=$1",[userId]); await pool.query("DELETE FROM memory_facts WHERE user_id=$1",[userId]); await pool.query("DELETE FROM user_profiles WHERE user_id=$1",[userId]); await pool.query("DELETE FROM conversations WHERE user_id=$1",[userId]); await pool.query('DELETE FROM "user" WHERE id=$1',[userId]); }
try {
  server=app.listen(port,"127.0.0.1");
  const signup=await fetch(`${origin}/api/auth/sign-up/email`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email,password,name:"Voice Verification"})});
  const account=await signup.json(); assert.equal(signup.status,200,JSON.stringify(account)); userId=account.user.id;
  await pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1',[userId]);
  const signin=await fetch(`${origin}/api/auth/sign-in/email`,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({email,password})});
  assert.equal(signin.status,200); const cookie=signin.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
  const audio=await readFile(process.env.VOICE_TEST_FILE);
  const result=await fetch(`${origin}/api/voice/transcribe`,{method:"POST",headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify({audio:audio.toString("base64"),mimeType:"audio/wav"})});
  const data=await result.json(); console.log(JSON.stringify({ transcriptionStatus: result.status, transcriptionResponse: data })); assert.equal(result.status,200,JSON.stringify(data)); assert.ok(data.text.length>0,"No spoken text returned.");
  console.log(JSON.stringify({voiceTranscription:"ok",characters:data.text.length}));
} finally { await cleanup(); console.log(JSON.stringify({testAccountAndDataDeleted:true})); if(server) await new Promise(r=>server.close(r)); await pool.end(); }
