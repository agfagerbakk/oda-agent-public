import { runOdaRaw } from "./oda-spawn.js";
import { config } from "./config.js";

async function runOda(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return runOdaRaw(args);
}

/** True if the stored cookie session is still authenticated with Oda. */
async function isLoggedIn(): Promise<boolean> {
  try {
    const { stdout, stderr } = await runOda(["auth", "user"]);
    // The CLI prints human status to stderr: "Logged in as: <name>" when
    // authenticated, else "Not logged in."
    return /logged in as/i.test(stdout + stderr);
  } catch (err) {
    console.warn(`[oda-auth] auth check failed, treating as logged out (${String(err).slice(0, 120)})`);
    return false;
  }
}

async function login(): Promise<void> {
  await runOda(["auth", "login", "--user", config.odaUser, "--pass", config.odaPass]);
}

/**
 * Ensure there is a valid Oda session before the bot starts serving. Logs in
 * with ODA_USER/ODA_PASS if the persisted session is missing or expired.
 */
export async function ensureLoggedIn(): Promise<void> {
  if (await isLoggedIn()) {
    console.log("[oda-auth] existing Oda session is valid");
    return;
  }
  console.log("[oda-auth] no valid session — logging in…");
  await login();
  if (!(await isLoggedIn())) {
    throw new Error("Oda login failed — check ODA_USER / ODA_PASS.");
  }
  console.log("[oda-auth] logged in to Oda");
}
