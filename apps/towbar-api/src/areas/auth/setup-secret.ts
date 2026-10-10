import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "../../env.js";

export function installationSetupSecret() {
  return createHmac("sha256", getEnv().TOWBAR_INTERNAL_HMAC_SECRET)
    .update("towbar:installation-setup:v1")
    .digest("base64url");
}
export function validInstallationSetupSecret(value: string) {
  const expected = Buffer.from(installationSetupSecret());
  const supplied = Buffer.from(value);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
